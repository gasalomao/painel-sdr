import { createRequire } from "node:module";
const require = createRequire(`${process.cwd()}/package.json`);
require("dotenv").config({ path: ".env.local", override: true });

const PROJECT = "ffde7c35-6016-48ce-b2d9-bc85db15ceba";
const CLIENT = "00000000-0000-0000-0000-00000000a001";
const MODEL = process.argv[2] || "gemini-3.8-flash-high";

async function main(): Promise<void> {
  const { getProject, getFiles } = await import("@/lib/sites/repository");
  const { getWebsiteSettings, composeWebsitePrompt } = await import("@/lib/sites/prompts");
  const { getEffectiveSkills } = await import("@/lib/sites/skills");
  const { WebsiteTools } = await import("@/lib/sites/tools");
  const { resolveGatewayCreds, gatewayChatWithFailover } = await import("@/lib/ai-provider");
  const [project, files, settings, skills] = await Promise.all([getProject(CLIENT, PROJECT), getFiles(CLIENT, PROJECT), getWebsiteSettings(), getEffectiveSkills(CLIENT)]);
  const system = composeWebsitePrompt(project, skills, settings.creative_prompt, "continue", files);
  const tools = new WebsiteTools(files, { context: {}, assets: [], impeccable: true }).definitions;
  const body = { model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: "continue" }], tools, tool_choice: "auto", parallel_tool_calls: false, reasoning: { effort: "low" }, max_tokens: 16000, stream: false };
  console.log("system chars:", system.length, "body bytes:", JSON.stringify(body).length);
  const creds = await resolveGatewayCreds({}, MODEL);
  console.log("gateway:", creds.baseUrl, creds.endpointId);
  for (const variant of ["full", "no-reasoning", "small"] as const) {
    const b: Record<string, unknown> = { ...body };
    if (variant !== "full") delete b.reasoning;
    if (variant === "small") b.messages = [{ role: "system", content: "Responda curto." }, { role: "user", content: "oi" }];
    const started = Date.now();
    try {
      const res = await gatewayChatWithFailover(MODEL, b, { baseUrl: creds.baseUrl, apiKey: creds.apiKey, endpointId: creds.endpointId }, { allowEmptyContent: true });
      const msg = res?.choices?.[0]?.message;
      console.log(variant, "OK", Date.now() - started, "ms", res?.choices?.[0]?.finish_reason, "tools:", msg?.tool_calls?.length ?? 0, String(msg?.content ?? "").slice(0, 120));
    } catch (error) {
      const e = error as { status?: number; message?: string; name?: string };
      console.log(variant, "FAIL", Date.now() - started, "ms", e.name, e.status, String(e.message).slice(0, 800));
    }
  }
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
