import {DatabaseSync} from 'node:sqlite';

// Only ticket ids and expiry times are persisted; no keys or terminal data.
export class TicketReplayStore {
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS used_tickets (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  }
  consume(id, expires, now = Math.floor(Date.now() / 1000)) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM used_tickets WHERE expires <= ?').run(now);
      const found = this.db.prepare('SELECT id FROM used_tickets WHERE id = ?').get(id);
      if (found) {this.db.exec('COMMIT'); return 'used';}
      if (this.db.prepare('SELECT COUNT(*) AS n FROM used_tickets').get().n >= 4096) {this.db.exec('COMMIT'); return 'full';}
      this.db.prepare('INSERT INTO used_tickets (id, expires) VALUES (?, ?)').run(id, expires);
      this.db.exec('COMMIT'); return 'ok';
    } catch (error) {this.db.exec('ROLLBACK'); throw error;}
  }
  close() {this.db.close();}
}
