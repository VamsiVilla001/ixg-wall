// The sign-in audit: one JSON line per event in DATA_DIR/auth-audit.log (who signed in or
// was refused, from which address, sign-outs, and every change to who may sign in). Never a
// password, a token or a secret. The file is rotated once it passes a few megabytes, keeping
// the one before. Admins read the latest entries in the Admin center.
const fs = require('fs');
const path = require('path');

const ROTATE_BYTES = 5 * 1024 * 1024;
const KEEP = 500; // entries kept in memory for the Admin center

class Audit {
  constructor({ dir, file = 'auth-audit.log', log = console.log } = {}) {
    this.path = dir ? path.join(dir, file) : null;
    this.recent = [];
    this.print = log;
    if (this.path) this.load();
  }

  // The last entries from disk, so the Admin center has history after a restart.
  load() {
    try {
      const lines = fs.readFileSync(this.path, 'utf8').trim().split('\n').slice(-KEEP);
      this.recent = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {
      this.recent = [];
    }
  }

  // action: signin | signout | access; result: ok | refused; who: an email, account id or
  // 'password'; detail: words, never a secret.
  record({ action, result = 'ok', who = '', role = '', addr = '', via = '', detail = '' }) {
    const entry = { at: new Date().toISOString(), action, result, who: String(who).slice(0, 254), role, via, addr: String(addr).slice(0, 64), detail: String(detail).slice(0, 300) };
    this.recent.push(entry);
    if (this.recent.length > KEEP) this.recent.splice(0, this.recent.length - KEEP);
    if (this.path) {
      try {
        try {
          if (fs.statSync(this.path).size > ROTATE_BYTES) fs.renameSync(this.path, `${this.path}.1`);
        } catch {
          // no file yet
        }
        fs.appendFileSync(this.path, `${JSON.stringify(entry)}\n`);
      } catch (err) {
        this.print(`Couldn't write the audit log: ${err.message}`);
      }
    }
    return entry;
  }

  // Newest first.
  list(limit = 100) {
    return this.recent.slice(-limit).reverse();
  }
}

module.exports = { Audit };
