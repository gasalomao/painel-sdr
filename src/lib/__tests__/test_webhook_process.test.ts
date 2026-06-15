import './setupEnv';
import { test, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://sistema-supabase.ridnii.easypanel.host';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey!);

import { getEffectiveStatus } from '../bot-status';
import { extractText, extractMessageType, extractMimetype, extractFileName, extractFileSize, extractQuoted } from '../../app/api/webhooks/whatsapp/route';

// We import the parts and run the exact webhook logic to see where it failed.
test("simulate webhook for Marcio Medeiros Advocacia", async () => {
  const body = {
    "data": {
      "key": {
        "id": "2AD29529E87C34E93F07-test-sim",
        "fromMe": false,
        "remoteJid": "5511997765220@s.whatsapp.net",
        "participant": "",
        "remoteJidAlt": "5511997765220@s.whatsapp.net",
        "addressingMode": "lid"
      },
      "source": "unknown",
      "status": "DELIVERY_ACK",
      "message": {
        "conversation": "Boa tarde, tudo bem?"
      },
      "pushName": "Márcio Medeiros",
      "instanceId": "e8d13564-17b6-4c0a-adb8-16a338c185a8",
      "messageType": "conversation",
      "messageTimestamp": 1779478456
    },
    "event": "messages.upsert",
    "apikey": "Gabriel@3074",
    "sender": "5511961607625@s.whatsapp.net",
    "instance": "00000_sao_paulo"
  };

  const eventName = body.event;
  const instanceName = body.instance;
  const clientId = '00000000-0000-0000-0000-00000000a001';

  const data = body.data;
  const message = data.message || {};
  const finalId = data.key?.id;
  const remoteJid = data.key?.remoteJid;
  const fromMe = data.key?.fromMe ?? false;
  const pushName = data.pushName;

  console.log("1. Parsing message...");
  const text = extractText(message);
  const msgType = extractMessageType(message);
  const mimetype = extractMimetype(message);
  const fileName = extractFileName(message);
  const fileSize = extractFileSize(message);
  const { quotedId, quotedText } = extractQuoted(message);

  expect(text).toBe("Boa tarde, tudo bem?");
  expect(msgType).toBe("text");

  console.log("2. Resolving contact & session...");
  // Let's call the actual findOrCreateContact & findOrCreateSession logic in the webhook.
  // Wait, let's fetch them directly from DB using supabase to see.
  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("remote_jid", remoteJid)
    .single();

  console.log("Contact found:", contact);
  expect(contact).toBeDefined();

  const { data: session } = await supabase
    .from("sessions")
    .select("id, contact_id, instance_name, bot_status, paused_by, paused_at, resume_at, agent_id")
    .eq("contact_id", contact!.id)
    .eq("instance_name", instanceName)
    .single();

  console.log("Session found:", session);
  expect(session).toBeDefined();

  const eff = await getEffectiveStatus(session as any);
  console.log("Effective status:", eff);

  console.log("3. Inserting into chats_dashboard...");
  const basePayload = {
    client_id: clientId,
    instance_name: instanceName,
    message_id: finalId,
    remote_jid: remoteJid,
    sender_type: 'customer',
    content: text,
    status_envio: "received",
    created_at: new Date().toISOString(),
  };

  const { error: dashErr } = await supabase.from("chats_dashboard").insert(basePayload);
  console.log("chats_dashboard insert result:", dashErr ? "FAIL: " + dashErr.message : "SUCCESS");
  expect(dashErr).toBeNull();

  console.log("4. Inserting V2 message...");
  const { error: insertError } = await supabase.from("messages").insert({
    client_id: clientId,
    session_id: session!.id,
    message_id: finalId,
    sender: 'customer',
    content: text || null,
    media_category: msgType as any,
    media_url: null,
    mimetype,
    file_name: fileName,
    file_size: fileSize,
    quoted_msg_id: quotedId,
    quoted_text: quotedText,
    delivery_status: "pending",
    created_at: new Date().toISOString(),
  });

  console.log("messages insert result:", insertError ? "FAIL: " + insertError.message : "SUCCESS");
  expect(insertError).toBeNull();

  // Cleanup
  await supabase.from("chats_dashboard").delete().eq("message_id", finalId);
  await supabase.from("messages").delete().eq("message_id", finalId);
  console.log("Cleanup complete!");
});
