
-- ====================================================
-- MIGRAÇÃO V2: SISTEMA OMNICHANNEL
-- Execute este SQL no Supabase Dashboard > SQL Editor
-- ====================================================

-- 1. ENUM Types (ignorar erro se já existirem)
DO $$ BEGIN
  CREATE TYPE session_status AS ENUM ('bot_active', 'bot_paused', 'human_takeover', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE sender_origin AS ENUM ('customer', 'ai', 'human', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE media_category AS ENUM ('text', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contact', 'reaction');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Tabela CONTACTS
CREATE TABLE IF NOT EXISTS contacts (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  remote_jid    TEXT NOT NULL UNIQUE,
  push_name     TEXT,
  phone_number  TEXT,
  profile_pic   TEXT,
  lead_id       INT,
  tags          TEXT[] DEFAULT '{}',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contacts_jid ON contacts(remote_jid);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone_number);

-- 3. Tabela SESSIONS
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  contact_id      UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  instance_name   TEXT NOT NULL DEFAULT 'sdr',
  agent_id        INT,

  bot_status      session_status NOT NULL DEFAULT 'bot_active',
  paused_by       TEXT,
  paused_at       TIMESTAMPTZ,
  resume_at       TIMESTAMPTZ,

  last_message_at TIMESTAMPTZ,
  unread_count    INT DEFAULT 0,
  current_stage   TEXT,

  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(contact_id, instance_name)
);

CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_name);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(bot_status);
CREATE INDEX IF NOT EXISTS idx_sessions_last_msg ON sessions(last_message_at DESC);

-- 4. Tabela MESSAGES
CREATE TABLE IF NOT EXISTS messages (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  message_id      TEXT UNIQUE,
  
  sender          sender_origin NOT NULL,
  
  content         TEXT,
  media_category  media_category NOT NULL DEFAULT 'text',
  media_url       TEXT,
  mimetype        TEXT,
  file_name       TEXT,
  file_size       BIGINT,
  
  quoted_msg_id   TEXT,
  quoted_text     TEXT,
  
  delivery_status TEXT DEFAULT 'pending',
  
  raw_payload     JSONB,
  
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_id ON messages(message_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);

-- 5. Ativar Realtime nas novas tabelas
ALTER PUBLICATION supabase_realtime ADD TABLE contacts;
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE messages;

-- 6. RLS (Row Level Security) — Desativado para service_role
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

-- Política para permitir todas as operações (o service_role key já bypassa RLS)
CREATE POLICY "Allow all for anon" ON contacts FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON sessions FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for anon" ON messages FOR ALL USING (true) WITH CHECK (true);

-- 7. Função de auto-update do updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS contacts_updated_at ON contacts;
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 8. Migrar dados existentes de chats_dashboard (se existir)
INSERT INTO contacts (remote_jid, phone_number, created_at)
SELECT DISTINCT
  cd.remote_jid,
  REPLACE(REPLACE(cd.remote_jid, '@s.whatsapp.net', ''), '@g.us', ''),
  MIN(cd.created_at)
FROM chats_dashboard cd
WHERE cd.remote_jid IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.remote_jid = cd.remote_jid)
GROUP BY cd.remote_jid
ON CONFLICT (remote_jid) DO NOTHING;

INSERT INTO sessions (contact_id, instance_name, last_message_at, created_at)
SELECT DISTINCT
  c.id,
  COALESCE(cd.instance_name, 'sdr'),
  MAX(cd.created_at),
  MIN(cd.created_at)
FROM chats_dashboard cd
JOIN contacts c ON c.remote_jid = cd.remote_jid
WHERE NOT EXISTS (
  SELECT 1 FROM sessions s 
  WHERE s.contact_id = c.id AND s.instance_name = COALESCE(cd.instance_name, 'sdr')
)
GROUP BY c.id, cd.instance_name
ON CONFLICT (contact_id, instance_name) DO NOTHING;

INSERT INTO messages (session_id, message_id, sender, content, media_category, media_url, mimetype, file_name, quoted_msg_id, quoted_text, delivery_status, created_at)
SELECT
  s.id,
  cd.message_id,
  CASE 
    WHEN cd.sender_type = 'customer' THEN 'customer'::sender_origin
    WHEN cd.sender_type = 'ai' THEN 'ai'::sender_origin
    WHEN cd.sender_type = 'human' THEN 'human'::sender_origin
    ELSE 'system'::sender_origin
  END,
  cd.content,
  CASE
    WHEN cd.media_type = 'image' THEN 'image'::media_category
    WHEN cd.media_type = 'audio' THEN 'audio'::media_category
    WHEN cd.media_type = 'video' THEN 'video'::media_category
    WHEN cd.media_type = 'document' THEN 'document'::media_category
    ELSE 'text'::media_category
  END,
  cd.media_url,
  cd.mimetype,
  cd.file_name,
  cd.quoted_id,
  cd.quoted_text,
  COALESCE(cd.status_envio, 'pending'),
  cd.created_at
FROM chats_dashboard cd
JOIN contacts c ON c.remote_jid = cd.remote_jid
JOIN sessions s ON s.contact_id = c.id AND s.instance_name = COALESCE(cd.instance_name, 'sdr')
WHERE cd.message_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.message_id = cd.message_id)
ON CONFLICT (message_id) DO NOTHING;

-- Vincular agent_id das sessions
UPDATE sessions s
SET agent_id = cc.agent_id
FROM channel_connections cc
WHERE s.instance_name = cc.instance_name
  AND s.agent_id IS NULL;

SELECT 'Migração concluída com sucesso!' AS status;
  