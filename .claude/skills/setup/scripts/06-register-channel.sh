#!/bin/bash
set -euo pipefail

# 06-register-channel.sh — Write channel registration config, create group folders

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
LOG_FILE="$PROJECT_ROOT/logs/setup.log"

mkdir -p "$PROJECT_ROOT/logs"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [register-channel] $*" >> "$LOG_FILE"; }

cd "$PROJECT_ROOT"

# Parse args
JID=""
NAME=""
TRIGGER=""
FOLDER=""
REQUIRES_TRIGGER="true"
ASSISTANT_NAME="hal"

while [[ $# -gt 0 ]]; do
  case $1 in
    --jid)              JID="$2"; shift 2 ;;
    --name)             NAME="$2"; shift 2 ;;
    --trigger)          TRIGGER="$2"; shift 2 ;;
    --folder)           FOLDER="$2"; shift 2 ;;
    --no-trigger-required) REQUIRES_TRIGGER="false"; shift ;;
    --assistant-name)   ASSISTANT_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

# Validate required args
if [ -z "$JID" ] || [ -z "$NAME" ] || [ -z "$TRIGGER" ] || [ -z "$FOLDER" ]; then
  log "ERROR: Missing required args (--jid, --name, --trigger, --folder)"
  cat <<EOF
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
STATUS: failed
ERROR: missing_required_args
LOG: logs/setup.log
=== END ===
EOF
  exit 4
fi

# For self-chat/personal chat, get the correct JID from creds.json
# The JID should include the device suffix (e.g., 886979972826:26@s.whatsapp.net)
if [ -f "$PROJECT_ROOT/store/auth/creds.json" ]; then
  # Extract the full JID from creds.json
  CORRECT_JID=$(node -e "
    try {
      const c = require('$PROJECT_ROOT/store/auth/creds.json');
      if (c && c.me && c.me.id) {
        console.log(c.me.id);
      }
    } catch (e) {
      // Fallback to provided JID
    }
  " 2>/dev/null || echo "")
  
  # If the provided JID matches the phone number in creds, use the correct format
  if [ -n "$CORRECT_JID" ]; then
    PHONE_FROM_PROVIDED=$(echo "$JID" | sed 's/[:@].*//')
    PHONE_FROM_CORRECT=$(echo "$CORRECT_JID" | sed 's/[:@].*//')
    if [ "$PHONE_FROM_PROVIDED" = "$PHONE_FROM_CORRECT" ]; then
      log "Using JID from creds.json: $CORRECT_JID (was: $JID)"
      JID="$CORRECT_JID"
    fi
  fi
fi

log "Registering channel: jid=$JID name=$NAME trigger=$TRIGGER folder=$FOLDER requiresTrigger=$REQUIRES_TRIGGER"

# Create data directory
mkdir -p "$PROJECT_ROOT/data"
mkdir -p "$PROJECT_ROOT/store"

# Ensure database and schema exist
DB_PATH="$PROJECT_ROOT/store/messages.db"
if [ ! -f "$DB_PATH" ]; then
  log "Creating database at $DB_PATH"
fi

# Initialize database schema if needed
node -e "
const Database = require('better-sqlite3');
const db = new Database('$DB_PATH');
db.exec(\`
  CREATE TABLE IF NOT EXISTS chats (
    jid TEXT PRIMARY KEY,
    name TEXT,
    last_message_time TEXT
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT,
    chat_jid TEXT,
    sender TEXT,
    sender_name TEXT,
    content TEXT,
    timestamp TEXT,
    is_from_me INTEGER,
    is_bot_message INTEGER DEFAULT 0,
    PRIMARY KEY (id, chat_jid),
    FOREIGN KEY (chat_jid) REFERENCES chats(jid)
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    group_folder TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule_type TEXT NOT NULL,
    schedule_value TEXT NOT NULL,
    next_run TEXT,
    last_run TEXT,
    last_result TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS registered_groups (
    jid TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder TEXT NOT NULL UNIQUE,
    trigger_pattern TEXT NOT NULL,
    added_at TEXT NOT NULL,
    container_config TEXT,
    requires_trigger INTEGER DEFAULT 1
  );
\`);
" 2>&1 | while read line; do log "$line"; done

# Write to database
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')
REQUIRES_TRIGGER_INT=$( [ "$REQUIRES_TRIGGER" = "true" ] && echo 1 || echo 0 )

sqlite3 "$DB_PATH" "INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger) VALUES ('$JID', '$NAME', '$FOLDER', '$TRIGGER', '$TIMESTAMP', NULL, $REQUIRES_TRIGGER_INT);"

log "Wrote registration to SQLite"

# Create group folders
mkdir -p "$PROJECT_ROOT/groups/$FOLDER/logs"
log "Created groups/$FOLDER/logs/"

# Update assistant name in CLAUDE.md files if different from default
NAME_UPDATED="false"
if [ "$ASSISTANT_NAME" != "hal" ]; then
  log "Updating assistant name from hal to $ASSISTANT_NAME"

  for md_file in groups/global/CLAUDE.md groups/main/CLAUDE.md; do
    if [ -f "$PROJECT_ROOT/$md_file" ]; then
      sed -i '' "s/^# hal$/# $ASSISTANT_NAME/" "$PROJECT_ROOT/$md_file"
      sed -i '' "s/You are hal/You are $ASSISTANT_NAME/g" "$PROJECT_ROOT/$md_file"
      log "Updated $md_file"
    else
      log "WARNING: $md_file not found, skipping name update"
    fi
  done

  NAME_UPDATED="true"
fi

cat <<EOF
=== NANOCLAW SETUP: REGISTER_CHANNEL ===
JID: $JID
NAME: $NAME
FOLDER: $FOLDER
TRIGGER: $TRIGGER
REQUIRES_TRIGGER: $REQUIRES_TRIGGER
ASSISTANT_NAME: $ASSISTANT_NAME
NAME_UPDATED: $NAME_UPDATED
STATUS: success
LOG: logs/setup.log
=== END ===
EOF
