// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * The client's file system for the request limit checks, held in memory and asynchronous like the real one.
 *
 * `clock` is the client's own clock, which a remote window's does not have to agree with. `slowRename` makes
 * rename(..., { overwrite: false }) what VS Code really does: a look at the target, and then a move that replaces
 * whatever is there (fileService.ts doValidateMoveCopy, diskFileSystemProvider.ts validateMoveCopy). With it, two
 * windows can both find the lock free and the second one's move lands on top of the first one's. `gapRename` is the
 * other half: an overwriting rename deletes the target, and only later moves the new file there (fileService.ts
 * doMoveCopy), and `tornRename` stops one of those after the delete, so the target is left with no file at all. A
 * rename onto a path with nothing there has no delete to stop after, and is never torn.
 *
 * `meta` shares modification times between two views of the same files. `remap(path)` gives one view a path of its
 * own for a file the other sees under another name, which is how two windows that both believe they hold the same lock
 * are set up. `gate(op, path)` is awaited before each operation and `after(op, path)` called after each change, for
 * checks that have to stop one window at a given step or look at the files between every two steps.
 */
function client(files, { refuse = '', clock = Date.now, slowRename = false, gapRename = false, tornRename = null, onRead, meta,
  remap = (p) => p, gate, after } = {}) {
  const times = meta || new Map(Object.keys(files).map((k) => [k, { mtime: clock() }]));
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  const dirs = (p) => [...new Set(Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1).split('/')[0]))];
  const err = (code) => Object.assign(new Error(code), { code });
  const tick = () => new Promise((r) => setImmediate(r));
  const uri = (p) => ({ path: p, with: (c) => uri(c.path) });
  const enter = async (op, p) => { await tick(); if (gate) await gate(op, p); };
  const changed = (op, p) => { if (after) after(op, p); };
  return {
    at: uri,
    files, meta: times,
    fs: {
      stat: async (u) => {
        const p = remap(u.path);
        await enter('stat', p);
        if (has(p)) return { mtime: times.get(p).mtime };
        if (dirs(p).length) return { mtime: 0 };
        throw err('ENOENT');
      },
      readFile: async (u) => {
        const p = remap(u.path);
        await enter('readFile', p);
        if (!has(p)) throw err('ENOENT');
        const bytes = new TextEncoder().encode(files[p]);
        if (onRead) onRead(p);
        return bytes;
      },
      writeFile: async (u, b) => {
        const p = remap(u.path);
        await enter('writeFile', p);
        if (refuse) throw err(refuse);
        files[p] = new TextDecoder().decode(b);
        times.set(p, { mtime: clock() });
        changed('writeFile', p);
      },
      rename: async (a, b, opts) => {
        const from = remap(a.path), to = remap(b.path);
        await enter('rename', to);
        if (!has(from)) throw err('ENOENT');
        const blocked = has(to);
        if (slowRename) await tick();
        if (blocked && !(opts && opts.overwrite)) throw err('EEXIST');
        if (blocked && tornRename && tornRename(to)) {
          delete files[to]; times.delete(to);
          changed('rename', to);
          throw err('EIO');
        }
        if (blocked && gapRename) {
          delete files[to]; times.delete(to);
          changed('rename', to);
          await tick();
        }
        files[to] = files[from]; times.set(to, times.get(from));
        delete files[from]; times.delete(from);
        changed('rename', to);
      },
      delete: async (u) => {
        const p = remap(u.path);
        await enter('delete', p);
        if (!has(p)) throw err('ENOENT');
        delete files[p]; times.delete(p);
        changed('delete', p);
      },
      readDirectory: async (u) => {
        const p = remap(u.path);
        await enter('readDirectory', p);
        const d = dirs(p);
        if (!d.length) throw err('ENOENT');
        return d.map((n) => [n, has(p + '/' + n) ? 1 : 2]);
      },
    },
  };
}

module.exports = { client };
