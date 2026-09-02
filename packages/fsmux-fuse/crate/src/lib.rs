//! Node-API binding around fuser. Every kernel request is forwarded to a
//! JavaScript handler through a threadsafe function and parked here until JS
//! answers through one of the `reply*` methods, so the fuser thread never
//! waits on JavaScript. Kernel cache invalidations run on their own thread for
//! the same reason in reverse: `inval_entry` can block until an outstanding
//! lookup is answered, and that answer comes from JavaScript.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use fuser::{
    AccessFlags, BackgroundSession, BsdFileFlags, Config, Errno, FileAttr, FileHandle, FileType,
    Filesystem, FopenFlags, Generation, INodeNo, InitFlags, KernelConfig, LockOwner, MountOption,
    Notifier, OpenAccMode, OpenFlags, RenameFlags, ReplyAttr, ReplyCreate, ReplyData,
    ReplyDirectory, ReplyDirectoryPlus, ReplyEmpty, ReplyEntry, ReplyOpen, ReplyStatfs, ReplyWrite,
    ReplyXattr, Request, SessionACL, TimeOrNow, WriteFlags,
};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

/// One kernel request as the JavaScript handler sees it. `id` keys the parked
/// reply; 0 means no reply is expected (`forget`).
#[napi(object)]
pub struct FuseRequest {
    pub id: u32,
    pub op: String,
    /// The node itself, or the parent for name-based operations.
    pub ino: BigInt,
    pub name: Option<String>,
    pub fh: Option<f64>,
    pub offset: Option<f64>,
    pub size: Option<u32>,
    pub nlookup: Option<f64>,
    pub uid: u32,
    pub gid: u32,
    pub pid: u32,
}

#[napi(object)]
pub struct FuseAttr {
    pub ino: BigInt,
    pub size: f64,
    /// 0 directory, 1 regular file, 2 symlink.
    pub kind: u32,
    pub perm: u32,
    pub nlink: u32,
    pub mtime_ms: f64,
    pub uid: u32,
    pub gid: u32,
    pub blksize: u32,
    /// Cache TTL for this reply, overriding the mount-wide defaults. Lets
    /// synthetic directories (rarely changing, invalidation-pushed) be cached
    /// longer than files.
    pub ttl_ms: Option<f64>,
}

#[napi(object)]
pub struct FuseDirEntry {
    pub ino: BigInt,
    /// Offset the kernel passes back to continue after this entry.
    pub offset: f64,
    pub kind: u32,
    pub name: String,
}

/// A readdirplus entry: name plus full attributes, so the kernel skips the
/// per-name lookup round trips that follow a plain readdir.
#[napi(object)]
pub struct FuseDirPlusEntry {
    /// Offset the kernel passes back to continue after this entry.
    pub offset: f64,
    pub name: String,
    pub attr: FuseAttr,
}

#[napi(object)]
pub struct FuseMountOptions {
    pub fs_name: Option<String>,
    pub allow_other: Option<bool>,
    pub auto_unmount: Option<bool>,
    pub entry_ttl_ms: Option<f64>,
    pub attr_ttl_ms: Option<f64>,
}

enum Pending {
    Entry(ReplyEntry),
    Attr(ReplyAttr),
    Data(ReplyData),
    Open(ReplyOpen),
    Empty(ReplyEmpty),
    Directory(ReplyDirectory),
    DirectoryPlus(ReplyDirectoryPlus),
}

impl Pending {
    fn error(self, err: Errno) {
        match self {
            Pending::Entry(r) => r.error(err),
            Pending::Attr(r) => r.error(err),
            Pending::Data(r) => r.error(err),
            Pending::Open(r) => r.error(err),
            Pending::Empty(r) => r.error(err),
            Pending::Directory(r) => r.error(err),
            Pending::DirectoryPlus(r) => r.error(err),
        }
    }
}

type Handler = ThreadsafeFunction<FuseRequest, Unknown<'static>, FuseRequest, Status, false>;

struct Shared {
    handler: Handler,
    pending: Mutex<HashMap<u32, Pending>>,
    next_id: AtomicU32,
    entry_ttl: Duration,
    attr_ttl: Duration,
}

impl Shared {
    fn take(&self, id: u32) -> Option<Pending> {
        self.pending.lock().unwrap().remove(&id)
    }
}

struct Fs {
    shared: Arc<Shared>,
}

fn big(value: u64) -> BigInt {
    BigInt::from(value)
}

fn small(value: &BigInt) -> u64 {
    value.get_u64().1
}

fn utf8(name: &OsStr) -> Option<String> {
    name.to_str().map(str::to_owned)
}

fn errno(code: i32) -> Errno {
    Errno::from_i32(code)
}

impl Fs {
    fn message(&self, req: &Request, id: u32, op: &str, ino: INodeNo) -> FuseRequest {
        FuseRequest {
            id,
            op: op.to_owned(),
            ino: big(ino.0),
            name: None,
            fh: None,
            offset: None,
            size: None,
            nlookup: None,
            uid: req.uid(),
            gid: req.gid(),
            pid: req.pid(),
        }
    }

    fn dispatch(
        &self,
        req: &Request,
        op: &str,
        ino: INodeNo,
        pending: Pending,
        fill: impl FnOnce(&mut FuseRequest),
    ) {
        let shared = &self.shared;
        let id = {
            let mut table = shared.pending.lock().unwrap();
            let mut id = shared.next_id.fetch_add(1, Ordering::Relaxed);
            while id == 0 || table.contains_key(&id) {
                id = shared.next_id.fetch_add(1, Ordering::Relaxed);
            }
            table.insert(id, pending);
            id
        };
        let mut message = self.message(req, id, op, ino);
        fill(&mut message);
        let status = shared
            .handler
            .call(message, ThreadsafeFunctionCallMode::NonBlocking);
        if status != Status::Ok {
            if let Some(pending) = shared.take(id) {
                pending.error(Errno::EIO);
            }
        }
    }
}

impl Filesystem for Fs {
    fn init(&mut self, _req: &Request, config: &mut KernelConfig) -> io::Result<()> {
        // READDIRPLUS folds the lookups that follow a readdir into it; AUTO
        // lets the kernel fall back to plain readdir where that is cheaper.
        // An old kernel without the capability just leaves it off.
        let _ = config
            .add_capabilities(InitFlags::FUSE_DO_READDIRPLUS | InitFlags::FUSE_READDIRPLUS_AUTO);
        Ok(())
    }

    fn lookup(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEntry) {
        let Some(name) = utf8(name) else {
            reply.error(Errno::ENOENT);
            return;
        };
        self.dispatch(req, "lookup", parent, Pending::Entry(reply), |m| {
            m.name = Some(name);
        });
    }

    fn forget(&self, req: &Request, ino: INodeNo, nlookup: u64) {
        let mut message = self.message(req, 0, "forget", ino);
        message.nlookup = Some(nlookup as f64);
        let _ = self
            .shared
            .handler
            .call(message, ThreadsafeFunctionCallMode::NonBlocking);
    }

    fn getattr(&self, req: &Request, ino: INodeNo, _fh: Option<FileHandle>, reply: ReplyAttr) {
        self.dispatch(req, "getattr", ino, Pending::Attr(reply), |_| {});
    }

    fn setattr(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _mode: Option<u32>,
        _uid: Option<u32>,
        _gid: Option<u32>,
        _size: Option<u64>,
        _atime: Option<TimeOrNow>,
        _mtime: Option<TimeOrNow>,
        _ctime: Option<SystemTime>,
        _fh: Option<FileHandle>,
        _crtime: Option<SystemTime>,
        _chgtime: Option<SystemTime>,
        _bkuptime: Option<SystemTime>,
        _flags: Option<BsdFileFlags>,
        reply: ReplyAttr,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn readlink(&self, req: &Request, ino: INodeNo, reply: ReplyData) {
        self.dispatch(req, "readlink", ino, Pending::Data(reply), |_| {});
    }

    fn mknod(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        _rdev: u32,
        reply: ReplyEntry,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn mkdir(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        reply: ReplyEntry,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn unlink(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let Some(name) = utf8(name) else {
            reply.error(Errno::ENOENT);
            return;
        };
        self.dispatch(req, "unlink", parent, Pending::Empty(reply), |m| {
            m.name = Some(name);
        });
    }

    fn rmdir(&self, req: &Request, parent: INodeNo, name: &OsStr, reply: ReplyEmpty) {
        let Some(name) = utf8(name) else {
            reply.error(Errno::ENOENT);
            return;
        };
        self.dispatch(req, "rmdir", parent, Pending::Empty(reply), |m| {
            m.name = Some(name);
        });
    }

    fn symlink(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _link_name: &OsStr,
        _target: &Path,
        reply: ReplyEntry,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn rename(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _newparent: INodeNo,
        _newname: &OsStr,
        _flags: RenameFlags,
        reply: ReplyEmpty,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn link(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _newparent: INodeNo,
        _newname: &OsStr,
        reply: ReplyEntry,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn open(&self, req: &Request, ino: INodeNo, flags: OpenFlags, reply: ReplyOpen) {
        if flags.acc_mode() != OpenAccMode::O_RDONLY {
            reply.error(errno(libc::EROFS));
            return;
        }
        self.dispatch(req, "open", ino, Pending::Open(reply), |_| {});
    }

    fn read(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        size: u32,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyData,
    ) {
        self.dispatch(req, "read", ino, Pending::Data(reply), |m| {
            m.fh = Some(fh.0 as f64);
            m.offset = Some(offset as f64);
            m.size = Some(size);
        });
    }

    fn write(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _offset: u64,
        _data: &[u8],
        _write_flags: WriteFlags,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        reply: ReplyWrite,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn flush(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _lock_owner: LockOwner,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn release(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        _flags: OpenFlags,
        _lock_owner: Option<LockOwner>,
        _flush: bool,
        reply: ReplyEmpty,
    ) {
        self.dispatch(req, "release", ino, Pending::Empty(reply), |m| {
            m.fh = Some(fh.0 as f64);
        });
    }

    fn fsync(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    fn readdir(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        reply: ReplyDirectory,
    ) {
        self.dispatch(req, "readdir", ino, Pending::Directory(reply), |m| {
            m.fh = Some(fh.0 as f64);
            m.offset = Some(offset as f64);
        });
    }

    fn readdirplus(
        &self,
        req: &Request,
        ino: INodeNo,
        fh: FileHandle,
        offset: u64,
        reply: ReplyDirectoryPlus,
    ) {
        self.dispatch(
            req,
            "readdirplus",
            ino,
            Pending::DirectoryPlus(reply),
            |m| {
                m.fh = Some(fh.0 as f64);
                m.offset = Some(offset as f64);
            },
        );
    }

    fn fsyncdir(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _fh: FileHandle,
        _datasync: bool,
        reply: ReplyEmpty,
    ) {
        reply.ok();
    }

    // Reported free rather than full: nothing can write here either way, but
    // tools pre-checking free space (and humans reading df) take 0 free at
    // face value. Matches the NFS server's SPACE_AVAIL story.
    fn statfs(&self, _req: &Request, _ino: INodeNo, reply: ReplyStatfs) {
        const BSIZE: u32 = 128 * 1024;
        let blocks = (1u64 << 50) / BSIZE as u64;
        let files = 1u64 << 32;
        reply.statfs(blocks, blocks, blocks, files, files, BSIZE, 255, BSIZE);
    }

    fn setxattr(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _name: &OsStr,
        _value: &[u8],
        _flags: i32,
        _position: u32,
        reply: ReplyEmpty,
    ) {
        reply.error(errno(libc::EROFS));
    }

    fn getxattr(
        &self,
        _req: &Request,
        _ino: INodeNo,
        _name: &OsStr,
        _size: u32,
        reply: ReplyXattr,
    ) {
        reply.error(errno(libc::ENODATA));
    }

    fn listxattr(&self, _req: &Request, _ino: INodeNo, size: u32, reply: ReplyXattr) {
        if size == 0 {
            reply.size(0);
        } else {
            reply.data(&[]);
        }
    }

    fn removexattr(&self, _req: &Request, _ino: INodeNo, _name: &OsStr, reply: ReplyEmpty) {
        reply.error(errno(libc::EROFS));
    }

    // Mode bits are informational; whether an operation is allowed is decided
    // by the operation itself, so the kernel's access checks always pass.
    fn access(&self, _req: &Request, _ino: INodeNo, _mask: AccessFlags, reply: ReplyEmpty) {
        reply.ok();
    }

    fn create(
        &self,
        _req: &Request,
        _parent: INodeNo,
        _name: &OsStr,
        _mode: u32,
        _umask: u32,
        _flags: i32,
        reply: ReplyCreate,
    ) {
        reply.error(errno(libc::EROFS));
    }
}

enum Notify {
    Inode(u64, i64, i64),
    Entry(u64, String),
}

fn spawn_notifier(notifier: Notifier) -> mpsc::Sender<Notify> {
    let (tx, rx) = mpsc::channel::<Notify>();
    thread::Builder::new()
        .name("fuse-notify".to_owned())
        .spawn(move || {
            for notify in rx {
                let _ = match notify {
                    Notify::Inode(ino, offset, len) => {
                        notifier.inval_inode(INodeNo(ino), offset, len)
                    }
                    Notify::Entry(parent, name) => {
                        notifier.inval_entry(INodeNo(parent), OsStr::new(&name))
                    }
                };
            }
        })
        .expect("spawn fuse-notify thread");
    tx
}

fn system_time(ms: f64) -> SystemTime {
    if ms.is_finite() && ms > 0.0 {
        UNIX_EPOCH + Duration::from_millis(ms as u64)
    } else {
        UNIX_EPOCH
    }
}

fn file_type(kind: u32) -> FileType {
    match kind {
        0 => FileType::Directory,
        2 => FileType::Symlink,
        _ => FileType::RegularFile,
    }
}

fn file_attr(attr: &FuseAttr) -> FileAttr {
    let size = if attr.size.is_finite() && attr.size > 0.0 {
        attr.size as u64
    } else {
        0
    };
    let time = system_time(attr.mtime_ms);
    FileAttr {
        ino: INodeNo(small(&attr.ino)),
        size,
        blocks: size.div_ceil(512),
        atime: time,
        mtime: time,
        ctime: time,
        crtime: time,
        kind: file_type(attr.kind),
        perm: (attr.perm & 0o7777) as u16,
        nlink: attr.nlink,
        uid: attr.uid,
        gid: attr.gid,
        rdev: 0,
        blksize: attr.blksize.max(512),
        flags: 0,
    }
}

fn duration_ms(value: Option<f64>, default_ms: u64) -> Duration {
    match value {
        Some(ms) if ms.is_finite() && ms >= 0.0 => Duration::from_millis(ms as u64),
        _ => Duration::from_millis(default_ms),
    }
}

/// A reply's own TTL when it carries one, else the mount-wide default.
fn reply_ttl(value: Option<f64>, default: Duration) -> Duration {
    match value {
        Some(ms) if ms.is_finite() && ms >= 0.0 => Duration::from_millis(ms as u64),
        _ => default,
    }
}

/// The attr of a negative entry reply: inode 0 tells the kernel to cache the
/// name's absence for the entry TTL; everything else is ignored.
fn negative_attr() -> FileAttr {
    FileAttr {
        ino: INodeNo(0),
        size: 0,
        blocks: 0,
        atime: UNIX_EPOCH,
        mtime: UNIX_EPOCH,
        ctime: UNIX_EPOCH,
        crtime: UNIX_EPOCH,
        kind: FileType::RegularFile,
        perm: 0,
        nlink: 0,
        uid: 0,
        gid: 0,
        rdev: 0,
        blksize: 512,
        flags: 0,
    }
}

/// Detach a mount whether or not anything still has files open in it. Root
/// can do it directly; anyone else goes through the setuid helper.
fn lazy_unmount(mountpoint: &str) -> io::Result<()> {
    match nix::mount::umount2(mountpoint, nix::mount::MntFlags::MNT_DETACH) {
        Ok(()) => Ok(()),
        Err(nix::errno::Errno::EPERM) => {
            let mut last = io::Error::from_raw_os_error(libc::EPERM);
            for helper in ["fusermount3", "fusermount"] {
                match Command::new(helper)
                    .args(["-u", "-z", "-q", "--", mountpoint])
                    .output()
                {
                    Ok(output) if output.status.success() => return Ok(()),
                    Ok(output) => {
                        last = io::Error::other(
                            String::from_utf8_lossy(&output.stderr).trim().to_owned(),
                        );
                    }
                    Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                    Err(err) => last = err,
                }
            }
            Err(last)
        }
        Err(err) => Err(err.into()),
    }
}

pub struct UnmountTask {
    session: Option<BackgroundSession>,
    shared: Arc<Shared>,
    mountpoint: String,
}

impl Task for UnmountTask {
    type Output = bool;
    type JsValue = bool;

    /// Returns whether the session thread finished. It keeps running while a
    /// detached connection still has open files; the process exit or the last
    /// close ends it.
    fn compute(&mut self) -> Result<bool> {
        let Some(session) = self.session.take() else {
            return Ok(true);
        };
        lazy_unmount(&self.mountpoint)
            .map_err(|err| Error::from_reason(format!("unmount {}: {err}", self.mountpoint)))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while !session.guard.is_finished() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let finished = session.guard.is_finished();
        // Dropping the session detaches its thread; the Mount inside sees the
        // path already gone and leaves it alone.
        drop(session);
        self.shared.pending.lock().unwrap().clear();
        Ok(finished)
    }

    fn resolve(&mut self, _env: Env, output: bool) -> Result<bool> {
        Ok(output)
    }
}

#[napi]
pub struct FuseMount {
    shared: Arc<Shared>,
    session: Mutex<Option<BackgroundSession>>,
    notify: Mutex<Option<mpsc::Sender<Notify>>>,
    mountpoint: String,
}

#[napi]
impl FuseMount {
    #[napi(getter)]
    pub fn mountpoint(&self) -> String {
        self.mountpoint.clone()
    }

    #[napi(getter)]
    pub fn mounted(&self) -> bool {
        self.session.lock().unwrap().is_some()
    }

    #[napi(getter)]
    pub fn pending(&self) -> u32 {
        self.shared.pending.lock().unwrap().len() as u32
    }

    #[napi]
    pub fn reply_entry(&self, id: u32, attr: FuseAttr) {
        match self.shared.take(id) {
            Some(Pending::Entry(reply)) => reply.entry_with_ttls(
                &reply_ttl(attr.ttl_ms, self.shared.attr_ttl),
                &reply_ttl(attr.ttl_ms, self.shared.entry_ttl),
                &file_attr(&attr),
                Generation(0),
            ),
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    /// Answer a lookup that found nothing. The kernel caches the absence for
    /// the entry TTL, so repeated probes for the same missing name stop
    /// arriving; an entry invalidation (or expiry) brings them back.
    #[napi]
    pub fn reply_entry_negative(&self, id: u32, ttl_ms: Option<f64>) {
        match self.shared.take(id) {
            Some(Pending::Entry(reply)) => reply.entry_with_ttls(
                &Duration::ZERO,
                &reply_ttl(ttl_ms, self.shared.entry_ttl),
                &negative_attr(),
                Generation(0),
            ),
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    #[napi]
    pub fn reply_attr(&self, id: u32, attr: FuseAttr) {
        match self.shared.take(id) {
            Some(Pending::Attr(reply)) => reply.attr(
                &reply_ttl(attr.ttl_ms, self.shared.attr_ttl),
                &file_attr(&attr),
            ),
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    #[napi]
    pub fn reply_data(&self, id: u32, data: Buffer) {
        match self.shared.take(id) {
            Some(Pending::Data(reply)) => reply.data(&data),
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    #[napi]
    pub fn reply_open(&self, id: u32, fh: f64, keep_cache: Option<bool>) {
        match self.shared.take(id) {
            Some(Pending::Open(reply)) => {
                let flags = if keep_cache.unwrap_or(false) {
                    FopenFlags::FOPEN_KEEP_CACHE
                } else {
                    FopenFlags::empty()
                };
                reply.opened(FileHandle(fh as u64), flags);
            }
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    #[napi]
    pub fn reply_ok(&self, id: u32) {
        match self.shared.take(id) {
            Some(Pending::Empty(reply)) => reply.ok(),
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    /// Adds entries until the kernel's buffer is full; the caller resumes from
    /// the offset of the last entry the kernel echoes back.
    #[napi]
    pub fn reply_directory(&self, id: u32, entries: Vec<FuseDirEntry>) {
        match self.shared.take(id) {
            Some(Pending::Directory(mut reply)) => {
                for entry in entries {
                    let full = reply.add(
                        INodeNo(small(&entry.ino)),
                        entry.offset as u64,
                        file_type(entry.kind),
                        &entry.name,
                    );
                    if full {
                        break;
                    }
                }
                reply.ok();
            }
            Some(other) => other.error(Errno::EIO),
            None => {}
        }
    }

    /// The directory reply with attributes per entry, so the kernel skips
    /// the follow-up lookups. Returns how many entries the kernel's buffer
    /// accepted: the kernel takes a lookup reference for each of those
    /// (`.` and `..` excepted), and none for the surplus.
    #[napi]
    pub fn reply_directory_plus(&self, id: u32, entries: Vec<FuseDirPlusEntry>) -> u32 {
        match self.shared.take(id) {
            Some(Pending::DirectoryPlus(mut reply)) => {
                let mut kept = 0u32;
                for entry in &entries {
                    let full = reply.add(
                        INodeNo(small(&entry.attr.ino)),
                        entry.offset as u64,
                        &entry.name,
                        &reply_ttl(entry.attr.ttl_ms, self.shared.entry_ttl),
                        &file_attr(&entry.attr),
                        Generation(0),
                    );
                    if full {
                        break;
                    }
                    kept += 1;
                }
                reply.ok();
                kept
            }
            Some(other) => {
                other.error(Errno::EIO);
                0
            }
            None => 0,
        }
    }

    #[napi]
    pub fn reply_error(&self, id: u32, code: i32) {
        if let Some(pending) = self.shared.take(id) {
            pending.error(errno(code));
        }
    }

    /// Drop cached attributes (offset -1) or data of an inode.
    #[napi]
    pub fn inval_inode(&self, ino: BigInt, offset: f64, len: f64) {
        if let Some(tx) = self.notify.lock().unwrap().as_ref() {
            let _ = tx.send(Notify::Inode(small(&ino), offset as i64, len as i64));
        }
    }

    /// Drop the kernel's cached name (positive or negative) under a directory.
    #[napi]
    pub fn inval_entry(&self, parent: BigInt, name: String) {
        if let Some(tx) = self.notify.lock().unwrap().as_ref() {
            let _ = tx.send(Notify::Entry(small(&parent), name));
        }
    }

    #[napi]
    pub fn unmount(&self) -> AsyncTask<UnmountTask> {
        self.notify.lock().unwrap().take();
        let session = self.session.lock().unwrap().take();
        AsyncTask::new(UnmountTask {
            session,
            shared: self.shared.clone(),
            mountpoint: self.mountpoint.clone(),
        })
    }
}

/// Mount `mountpoint` and start answering the kernel through `handler`.
#[napi]
pub fn mount(
    mountpoint: String,
    options: FuseMountOptions,
    handler: ThreadsafeFunction<FuseRequest, Unknown<'static>, FuseRequest, Status, false>,
) -> Result<FuseMount> {
    let fs_name = options
        .fs_name
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "fsmux".to_owned());
    let mut config = Config::default();
    config.mount_options = vec![
        MountOption::FSName(fs_name.clone()),
        MountOption::Subtype(fs_name),
        MountOption::NoAtime,
    ];
    if options.allow_other.unwrap_or(false) {
        config.acl = SessionACL::All;
    }
    if options.auto_unmount.unwrap_or(false) {
        config.mount_options.push(MountOption::AutoUnmount);
    }
    let shared = Arc::new(Shared {
        handler,
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU32::new(1),
        entry_ttl: duration_ms(options.entry_ttl_ms, 1000),
        attr_ttl: duration_ms(options.attr_ttl_ms, 1000),
    });
    let session = fuser::spawn_mount(
        Fs {
            shared: shared.clone(),
        },
        &mountpoint,
        &config,
    )
    .map_err(|err| {
        let code = err.raw_os_error().unwrap_or(0);
        Error::from_reason(format!("mount {mountpoint}: {err} (errno {code})"))
    })?;
    let notify = spawn_notifier(session.notifier());
    Ok(FuseMount {
        shared,
        session: Mutex::new(Some(session)),
        notify: Mutex::new(Some(notify)),
        mountpoint,
    })
}

/// Lazily detach whatever is mounted at `mountpoint` (a stale mount left by a
/// dead process, typically).
#[napi]
pub fn umount_detach(mountpoint: String) -> Result<()> {
    lazy_unmount(&mountpoint)
        .map_err(|err| Error::from_reason(format!("detach {mountpoint}: {err}")))
}
