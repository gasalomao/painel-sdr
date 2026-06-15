import './setupEnv'; // Must be the absolute first line!
import { createClient } from '@supabase/supabase-js'
import { test, expect } from 'vitest'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sistema-supabase.ridnii.easypanel.host'
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const supabase = createClient(supabaseUrl, supabaseServiceKey!)

import { getEffectiveStatus } from '../bot-status'

async function findOrCreateSession(contactId: string, instanceName: string, remoteJid: string, clientId: string) {
  const { data: existing } = await supabase
    .from("sessions")
    .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
    .eq("contact_id", contactId)
    .eq("instance_name", instanceName)
    .maybeSingle();

  if (existing) {
    const eff = await getEffectiveStatus(existing as any);
    return { ...existing, bot_status: eff.status, resume_at: eff.resumeAt, _effective_active: eff.isActive };
  }

  const { data: channel } = await supabase
    .from("channel_connections")
    .select("agent_id")
    .eq("instance_name", instanceName)
    .maybeSingle();

  const { data: newSession, error } = await supabase.from("sessions").insert({
    client_id: clientId,
    contact_id: contactId,
    instance_name: instanceName,
    agent_id: channel?.agent_id || 1,
    bot_status: 'bot_active',
  }).select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id").single();

  if (error) {
    if (error.code === "23505") {
      const { data: retry } = await supabase
        .from("sessions").select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
        .eq("contact_id", contactId).eq("instance_name", instanceName).single();
      return retry;
    }
    throw error;
  }
  return newSession;
}

test("findOrCreateSession test", async () => {
  const contactId = '91e8565d-479d-4fbb-acac-ae6817f252c2';
  const instanceName = '00000_sao_paulo';
  const remoteJid = '5511997765220@s.whatsapp.net';
  const clientId = '00000000-0000-0000-0000-00000000a001';

  console.log("Running findOrCreateSession in vitest...");
  const session = await findOrCreateSession(contactId, instanceName, remoteJid, clientId);
  console.log("Resolved session:", session);
  expect(session).toBeDefined();
});
