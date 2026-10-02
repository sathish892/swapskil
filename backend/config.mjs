import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = resolve(rootDir, 'backend', 'data');

export function loadEnv() {
  try {
    const contents = readFileSync(resolve(rootDir, '.env'), 'utf8').replace(/^\uFEFF/, '');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match && process.env[match[1]] === undefined) {
        const value = match[2].replace(/^(["'])(.*)\1$/, '$2');
        process.env[match[1]] = value;
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

// Load private environment configuration before deriving paths and settings.
loadEnv();
export const databasePath = resolve(rootDir, process.env.SKILLSWAP_DB_PATH || resolve(dataDir, 'skillswap.sqlite'));

export function openDatabase() {
  mkdirSync(dirname(databasePath), { recursive: true });
  // SQLite is built into the supported Node runtime; user secrets never leave the server.
  // eslint-disable-next-line no-undef
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS skill_swaps (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      reported_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      swap_request_id TEXT REFERENCES swap_requests(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      reason TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      admin_note TEXT NOT NULL DEFAULT '',
      resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      resolved_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS user_skills (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('TEACH', 'LEARN')),
      level TEXT NOT NULL CHECK (level IN ('BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, skill_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_user_skills_skill_type ON user_skills(skill_id, type, user_id);
    CREATE TABLE IF NOT EXISTS swap_requests (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_offered_id TEXT NOT NULL REFERENCES skills(id),
      skill_wanted_id TEXT NOT NULL REFERENCES skills(id),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED')),
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (sender_id != receiver_id)
    );
    CREATE TABLE IF NOT EXISTS availability_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      visibility TEXT NOT NULL DEFAULT 'MATCHES' CHECK (visibility IN ('PUBLIC','MATCHES','PARTNERS')),
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS availability_slots (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (start_time < end_time)
    );
    CREATE INDEX IF NOT EXISTS idx_availability_user_day ON availability_slots(user_id,day_of_week,is_active,start_time);
    CREATE TABLE IF NOT EXISTS skill_sessions (
      id TEXT PRIMARY KEY,
      swap_request_id TEXT NOT NULL REFERENCES swap_requests(id) ON DELETE CASCADE,
      proposer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','CONFIRMED','COMPLETED','CANCELLED')),
      meeting_link TEXT,
      notes TEXT NOT NULL DEFAULT '',
      reschedules_session_id TEXT REFERENCES skill_sessions(id) ON DELETE CASCADE,
      proposer_completed_at TEXT,
      partner_completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (proposer_id != '')
    );
    CREATE INDEX IF NOT EXISTS idx_skill_sessions_swap_status ON skill_sessions(swap_request_id,status,start_at);
    CREATE INDEX IF NOT EXISTS idx_skill_sessions_status_start_end ON skill_sessions(status,start_at,end_at);
    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      swap_request_id TEXT REFERENCES swap_requests(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES skill_sessions(id) ON DELETE SET NULL,
      amount INTEGER NOT NULL CHECK (amount > 0),
      currency TEXT NOT NULL CHECK (length(currency)=3),
      status TEXT NOT NULL CHECK (status IN ('CREATED','PENDING','SUCCESS','FAILED','CANCELLED','REFUNDED')),
      provider TEXT NOT NULL,
      provider_payment_id TEXT,
      provider_order_id TEXT,
      provider_refund_id TEXT,
      description TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payments_swap ON payments(swap_request_id);
    CREATE INDEX IF NOT EXISTS idx_payments_session ON payments(session_id);
    CREATE INDEX IF NOT EXISTS idx_payments_provider_payment ON payments(provider_payment_id);
    CREATE INDEX IF NOT EXISTS idx_payments_provider_order ON payments(provider_order_id);
    CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_active_session ON payments(user_id,session_id) WHERE session_id IS NOT NULL AND status IN ('CREATED','PENDING','SUCCESS');
    CREATE TABLE IF NOT EXISTS payment_webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL CHECK(plan IN ('WEEKLY','MONTHLY')),
      amount INTEGER NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL CHECK(length(currency)=3),
      status TEXT NOT NULL CHECK(status IN ('ACTIVE','EXPIRED','CANCELLED','PENDING')),
      start_at TEXT,
      end_at TEXT,
      payment_id TEXT UNIQUE REFERENCES payments(id) ON DELETE SET NULL,
      provider TEXT NOT NULL,
      expiring_notified_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK((status='ACTIVE' AND start_at IS NOT NULL AND end_at IS NOT NULL) OR status!='ACTIVE')
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_created ON subscriptions(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_expiry ON subscriptions(status,end_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_one_open_per_user ON subscriptions(user_id) WHERE status IN ('ACTIVE','PENDING');
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      user_one_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_two_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_one_id, user_two_id),
      CHECK (user_one_id < user_two_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_participants (
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL CHECK(length(content) <= 2000),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      read_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('NEW_MATCH','SWAP_REQUEST','SWAP_ACCEPTED','SWAP_REJECTED','NEW_MESSAGE','PROFILE_ACTIVITY','SYSTEM','REVIEW_RECEIVED','SESSION_PROPOSED','SESSION_CONFIRMED','SESSION_DECLINED','SESSION_RESCHEDULED','SESSION_CANCELLED','SESSION_COMPLETED','PAYMENT_SUCCESS','PAYMENT_FAILED','PAYMENT_REFUNDED')),
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      related_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      related_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      related_swap_request_id TEXT REFERENCES swap_requests(id) ON DELETE SET NULL,
      related_skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
      related_session_id TEXT REFERENCES skill_sessions(id) ON DELETE SET NULL,
      is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
      dedupe_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      swap_request_id TEXT NOT NULL REFERENCES swap_requests(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment TEXT NOT NULL DEFAULT '' CHECK (length(comment) <= 500),
      review_type TEXT NOT NULL DEFAULT 'TEACHING' CHECK(review_type IN ('TEACHING','LEARNING')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (reviewer_id != reviewee_id),
      UNIQUE (reviewer_id, swap_request_id, review_type)
    );
    CREATE INDEX IF NOT EXISTS idx_conversation_participants_user ON conversation_participants(user_id, conversation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(conversation_id, sender_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created ON notifications(user_id,is_read,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_created ON reviews(reviewer_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_reviewee_created ON reviews(reviewee_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_swap_request ON reviews(swap_request_id);
    CREATE INDEX IF NOT EXISTS idx_swap_requests_sender ON swap_requests(sender_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swap_requests_receiver ON swap_requests(receiver_id, created_at DESC);
  `);

  const addColumn = (table, column, definition) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('users', 'avatar', 'TEXT');
  addColumn('users', 'bio', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'college', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'location', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'website', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'learning_goals', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'profile_visibility', "TEXT NOT NULL DEFAULT 'PUBLIC'");
  addColumn('users', 'show_email', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'suspended_at', 'TEXT');
  addColumn('users', 'suspended_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  addColumn('users', 'suspension_reason', "TEXT NOT NULL DEFAULT ''");
  addColumn('users', 'verification_status', "TEXT NOT NULL DEFAULT 'UNVERIFIED'");
  addColumn('users', 'deleted_at', 'TEXT');
  addColumn('users', 'allow_direct_messages', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'allow_swap_requests', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'show_availability', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'show_reviews', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'show_presence', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('reviews', 'review_type', "TEXT NOT NULL DEFAULT 'TEACHING'");
  const reviewDefinition=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reviews'").get()?.sql||'';
  if(/UNIQUE\s*\(\s*reviewer_id\s*,\s*swap_request_id\s*\)/i.test(reviewDefinition)){
    db.exec(`BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS idx_reviews_reviewer_created;
      DROP INDEX IF EXISTS idx_reviews_reviewee_created;
      DROP INDEX IF EXISTS idx_reviews_swap_request;
      ALTER TABLE reviews RENAME TO reviews_legacy;
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY, reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        reviewee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        swap_request_id TEXT NOT NULL REFERENCES swap_requests(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        comment TEXT NOT NULL DEFAULT '' CHECK(length(comment)<=500),
        review_type TEXT NOT NULL DEFAULT 'TEACHING' CHECK(review_type IN ('TEACHING','LEARNING')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(reviewer_id!=reviewee_id), UNIQUE(reviewer_id,swap_request_id,review_type)
      );
      INSERT INTO reviews(id,reviewer_id,reviewee_id,swap_request_id,rating,comment,review_type,created_at,updated_at)
        SELECT id,reviewer_id,reviewee_id,swap_request_id,rating,comment,review_type,created_at,updated_at FROM reviews_legacy;
      DROP TABLE reviews_legacy;
      CREATE INDEX idx_reviews_reviewer_created ON reviews(reviewer_id,created_at DESC);
      CREATE INDEX idx_reviews_reviewee_created ON reviews(reviewee_id,created_at DESC);
      CREATE INDEX idx_reviews_swap_request ON reviews(swap_request_id);
      COMMIT;`);
  }
  addColumn('sessions', 'last_seen_at', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE sessions SET last_seen_at=created_at WHERE last_seen_at=''");
  addColumn('sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS user_blocks (
    id TEXT PRIMARY KEY, blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(blocker_id<>blocked_user_id),
    UNIQUE(blocker_id,blocked_user_id));
    CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_user_id,blocker_id);
    CREATE TABLE IF NOT EXISTS account_deletion_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'PENDING', requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_at TEXT, completed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_deletion_pending ON account_deletion_requests(user_id) WHERE status='PENDING';`);
  db.exec("UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE updated_at = ''");
  addColumn('skills', 'category', "TEXT NOT NULL DEFAULT 'Other'");
  addColumn('skills', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn('skills', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('reports', 'reporter_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  addColumn('reports', 'reported_user_id', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  addColumn('reports', 'swap_request_id', 'TEXT REFERENCES swap_requests(id) ON DELETE SET NULL');
  addColumn('reports', 'message_id', 'TEXT REFERENCES messages(id) ON DELETE SET NULL');
  addColumn('reports', 'reason', "TEXT NOT NULL DEFAULT ''");
  addColumn('reports', 'description', "TEXT NOT NULL DEFAULT ''");
  addColumn('reports', 'admin_note', "TEXT NOT NULL DEFAULT ''");
  addColumn('reports', 'resolved_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL');
  addColumn('reports', 'resolved_at', 'TEXT');
  addColumn('reports', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE reports SET updated_at=created_at WHERE updated_at IS NULL OR updated_at=''");
  db.exec("UPDATE reports SET status=CASE lower(status) WHEN 'pending' THEN 'OPEN' WHEN 'open' THEN 'OPEN' WHEN 'under_review' THEN 'UNDER_REVIEW' WHEN 'resolved' THEN 'RESOLVED' WHEN 'dismissed' THEN 'DISMISSED' ELSE 'OPEN' END");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_reports_status_created ON reports(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reports_target_user ON reports(reported_user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
      id TEXT PRIMARY KEY,
      admin_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_logs(action,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_logs(target_type,target_id,created_at DESC);`);
  addColumn('swap_requests', 'sender_completed_at', 'TEXT');
  addColumn('swap_requests', 'receiver_completed_at', 'TEXT');
  addColumn('swap_requests', 'completed_at', 'TEXT');
  // Keep the original status column compatible with earlier builds while the
  // workflow_status column carries the expanded exchange lifecycle.
  addColumn('swap_requests', 'workflow_status', 'TEXT');
  addColumn('swap_requests', 'accepted_at', 'TEXT');
  addColumn('swap_requests', 'started_at', 'TEXT');
  addColumn('swap_requests', 'cancelled_at', 'TEXT');
  addColumn('messages', 'is_system', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('notifications', 'related_session_id', 'TEXT REFERENCES skill_sessions(id) ON DELETE SET NULL');
  db.exec(`UPDATE swap_requests SET workflow_status=CASE
    WHEN completed_at IS NOT NULL OR (sender_completed_at IS NOT NULL AND receiver_completed_at IS NOT NULL) THEN 'COMPLETED'
    WHEN workflow_status IS NOT NULL THEN workflow_status ELSE status END
    WHERE workflow_status IS NULL`);
  db.exec(`UPDATE swap_requests SET accepted_at=COALESCE(accepted_at,updated_at,created_at)
    WHERE workflow_status IN ('ACCEPTED','IN_PROGRESS','COMPLETED');
    UPDATE swap_requests SET started_at=COALESCE(started_at,completed_at,updated_at,created_at)
    WHERE workflow_status IN ('IN_PROGRESS','COMPLETED');
    UPDATE swap_requests SET completed_at=COALESCE(completed_at,updated_at,created_at)
    WHERE workflow_status='COMPLETED';`);
  const notificationsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='notifications'").get()?.sql || '';
  if (!notificationsSql.includes('PAYMENT_SUCCESS')) {
    db.exec(`
      BEGIN;
      CREATE TABLE notifications_v2 (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK (type IN ('NEW_MATCH','SWAP_REQUEST','SWAP_ACCEPTED','SWAP_REJECTED','NEW_MESSAGE','PROFILE_ACTIVITY','SYSTEM','REVIEW_RECEIVED','SESSION_PROPOSED','SESSION_CONFIRMED','SESSION_DECLINED','SESSION_RESCHEDULED','SESSION_CANCELLED','SESSION_COMPLETED','PAYMENT_SUCCESS','PAYMENT_FAILED','PAYMENT_REFUNDED')),
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        related_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        related_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
        related_swap_request_id TEXT REFERENCES swap_requests(id) ON DELETE SET NULL,
        related_skill_id TEXT REFERENCES skills(id) ON DELETE SET NULL,
        related_session_id TEXT REFERENCES skill_sessions(id) ON DELETE SET NULL,
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
        dedupe_key TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO notifications_v2 (id,user_id,type,title,message,related_user_id,related_conversation_id,related_swap_request_id,related_skill_id,related_session_id,is_read,dedupe_key,created_at,updated_at)
      SELECT id,user_id,type,title,message,related_user_id,related_conversation_id,related_swap_request_id,related_skill_id,related_session_id,is_read,dedupe_key,created_at,updated_at FROM notifications;
      DROP TABLE notifications;
      ALTER TABLE notifications_v2 RENAME TO notifications;
      CREATE INDEX idx_notifications_user_read_created ON notifications(user_id,is_read,created_at DESC);
      CREATE INDEX idx_notifications_user_created ON notifications(user_id,created_at DESC);
      COMMIT;
    `);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_single_reschedule ON skill_sessions(reschedules_session_id) WHERE reschedules_session_id IS NOT NULL AND status='PROPOSED';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_name_nocase ON skills(name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_swap_requests_workflow_sender ON swap_requests(workflow_status,sender_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_swap_requests_workflow_receiver ON swap_requests(workflow_status,receiver_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_user_skills_discovery ON user_skills(skill_id,type,level,user_id);
    CREATE INDEX IF NOT EXISTS idx_users_discovery_name ON users(name COLLATE NOCASE,status,profile_visibility);
    CREATE INDEX IF NOT EXISTS idx_users_discovery_location ON users(location COLLATE NOCASE,status,profile_visibility);
    CREATE INDEX IF NOT EXISTS idx_skills_category_name ON skills(category COLLATE NOCASE,name COLLATE NOCASE);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_swap_request_unique
      ON swap_requests(sender_id, receiver_id, skill_offered_id, skill_wanted_id)
      WHERE status = 'PENDING';
  `);

  const catalog = [
    ['Python', 'Programming'], ['JavaScript', 'Programming'], ['TypeScript', 'Programming'],
    ['Web Development', 'Programming'], ['Data Analysis', 'Data'], ['Machine Learning', 'Data'],
    ['SQL', 'Data'], ['Cybersecurity', 'Technology'], ['Cloud Computing', 'Technology'],
    ['Git and GitHub', 'Technology'], ['UI/UX Design', 'Design'], ['Graphic Design', 'Design'],
    ['Canva', 'Design'], ['Figma', 'Design'], ['Photography', 'Creative'], ['Video Editing', 'Creative'],
    ['Illustration', 'Creative'], ['Writing', 'Creative'], ['Public Speaking', 'Communication'],
    ['English', 'Languages'], ['Japanese', 'Languages'], ['Spanish', 'Languages'], ['French', 'Languages'],
    ['Digital Marketing', 'Marketing'], ['Social Media Marketing', 'Marketing'], ['SEO', 'Marketing'],
    ['Project Management', 'Business'], ['Leadership', 'Business'], ['Excel', 'Business'],
    ['Entrepreneurship', 'Business'], ['Guitar', 'Music'], ['Piano', 'Music'], ['Singing', 'Music'],
    ['Yoga', 'Wellness'], ['Cooking', 'Lifestyle'], ['Personal Finance', 'Finance'], ['Mathematics', 'Education'],
  ];
  const insertSkill = db.prepare('INSERT OR IGNORE INTO skills (id, name, category, description) VALUES (?, ?, ?, ?)');
  for (const [name, category] of catalog) insertSkill.run(randomId(), name, category, '');
  return db;
}

function randomId() {
  return globalThis.crypto.randomUUID();
}
