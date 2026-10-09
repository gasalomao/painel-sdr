/**
 * Teste: Verificar se a skill Impeccable Design está ativa e funcionando
 * Roda: tsx scripts/test-impeccable-skill.ts
 */

import { config } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "../src/types/supabase";

// Carregar variáveis de ambiente
config({ path: ".env.local" });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient<Database>(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function testImpeccableSkill() {
  console.log("🔍 Testando skill Impeccable Design...\n");

  // 1. Verificar se a skill existe no banco
  const { data: skills, error: skillError } = await supabase
    .from("website_skills")
    .select("*")
    .eq("slug", "impeccable-design")
    .order("created_at", { ascending: false });

  if (skillError) {
    console.error("❌ Erro ao buscar skill:", skillError);
    process.exit(1);
  }

  if (!skills || skills.length === 0) {
    console.error("❌ Skill 'impeccable-design' não encontrada no banco!");
    console.log("\n💡 Rode a migration 018:");
    console.log("   psql $DATABASE_URL < migrations/018_enable_impeccable_skill.sql");
    process.exit(1);
  }

  if (skills.length > 1) {
    console.warn(`⚠️  Encontradas ${skills.length} entradas duplicadas para 'impeccable-design'!`);
    console.log("   IDs:", skills.map(s => s.id).join(", "));
    console.log("   Usando a mais recente (ID: " + skills[0].id + ")\n");
  }

  const skill = skills[0];

  console.log("✅ Skill encontrada no banco:");
  console.log(`   ID: ${skill.id}`);
  console.log(`   Nome: ${skill.name}`);
  console.log(`   Slug: ${skill.slug}`);
  console.log(`   Ativa: ${skill.is_enabled}`);
  console.log(`   Builtin: ${skill.is_builtin}`);
  console.log(`   Trigger: ${skill.trigger_mode}`);
  console.log(`   Prioridade: ${skill.priority}`);

  if (!skill.is_enabled) {
    console.warn("\n⚠️  Skill existe mas está DESATIVADA!");
    process.exit(1);
  }

  if (skill.trigger_mode !== "always") {
    console.warn(`\n⚠️  Skill tem trigger_mode='${skill.trigger_mode}' (esperado: 'always')`);
  }

  // 2. Verificar se composeImpeccableGuidance existe
  try {
    const { composeImpeccableGuidance } = await import("../src/lib/sites/impeccable");
    console.log("\n✅ Módulo impeccable.ts importado com sucesso");

    const guidance = composeImpeccableGuidance();
    console.log(`   Guidance gerado: ${guidance.length} caracteres`);

    if (guidance.length < 1000) {
      console.warn("⚠️  Guidance muito curto — pode estar incompleto!");
    }

    // Verificar presença de módulos-chave
    const keyModules = [
      "briefing",
      "direção visual",
      "tipografia",
      "cor",
      "layout",
      "responsivo",
      "acessibilidade",
    ];

    const missing = keyModules.filter(m => !guidance.toLowerCase().includes(m));
    if (missing.length > 0) {
      console.warn(`⚠️  Módulos faltando no guidance: ${missing.join(", ")}`);
    } else {
      console.log(`✅ Todos os ${keyModules.length} módulos-chave presentes`);
    }

  } catch (err) {
    console.error("❌ Erro ao importar impeccable.ts:", err);
    process.exit(1);
  }

  console.log("\n🎉 Teste concluído com sucesso!");
  console.log("   A skill Impeccable Design está ativa e operacional.\n");
}

testImpeccableSkill().catch(err => {
  console.error("💥 Erro fatal:", err);
  process.exit(1);
});
