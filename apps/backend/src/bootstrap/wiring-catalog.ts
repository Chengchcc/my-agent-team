import type { Database } from "bun:sqlite";
import type { BackendConfig } from "../config.js";
import { probeHarnessCatalog } from "../features/agent-run/acp/harness-catalog.js";
import { ACP_AGENTS } from "../features/agent-run/acp/registry.js";
import {
  createHarnessCatalog,
  createOmaModelCatalog,
  createProviderModelProbe,
  createServedModelKnowledge,
} from "../features/models/index.js";
import { createProviderService } from "../features/provider/index.js";
import type { SettingsService } from "../features/settings/index.js";
import {
  checkUpstream,
  createSkillPackService,
  runInstall,
  runSync,
  seedSkillPacks,
  setSkillPackPort,
  sqliteSkillPackAdapter,
} from "../features/skill-pack/index.js";
import { resolveOmaAcpArgv, resolveOmaCommand } from "../infra/oma-command.js";

export interface CatalogWiringDeps {
  config: BackendConfig;
  db: Database;
  ulid: () => string;
  settingsSvc: SettingsService;
  probeEnv: NodeJS.ProcessEnv;
}

/** Wire providers, Oma model catalog, ACP harness catalog, served-model
 *  availability probe, and deterministic skill-pack registry + seeding. */
export async function wireCatalogs(deps: CatalogWiringDeps) {
  const { config, db, ulid, settingsSvc, probeEnv } = deps;

  const providerSvc = createProviderService(settingsSvc);
  const codingAgentCommand = resolveOmaCommand(config, { env: providerSvc.getProviderEnv() });
  const codingAgentCatalog = createOmaModelCatalog(codingAgentCommand);

  const refreshOmaProviderEnv = () => {
    codingAgentCommand.env = resolveOmaCommand(config, { env: providerSvc.getProviderEnv() }).env;
    codingAgentCatalog.invalidate();
  };

  const omaAcpArgv = resolveOmaAcpArgv(config, { env: providerSvc.getProviderEnv() });
  const harnessCatalog = createHarnessCatalog({
    harnesses: () => Object.entries(ACP_AGENTS).map(([key, entry]) => ({ key, name: entry.name })),
    probe: (key) =>
      probeHarnessCatalog({ key, cwd: config.dataDir, commands: { oma: omaAcpArgv } }),
  });

  const servedModelKnowledge = createServedModelKnowledge({
    probe: createProviderModelProbe({ env: probeEnv }),
  });

  const skillPackPort = sqliteSkillPackAdapter(db);
  setSkillPackPort(skillPackPort);
  await seedSkillPacks({
    port: skillPackPort,
    dataDir: config.dataDir,
    builtinSkillsDir: config.builtinSkillsDir,
  });

  const skillPackSvc = createSkillPackService({
    port: skillPackPort,
    idGen: ulid,
    checkSync: async (packId, ctx) =>
      checkUpstream(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        { dataDir: config.dataDir, port: skillPackPort },
      ),
    triggerInstall: (packId, ctx) => {
      void runInstall(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
        },
        {
          dataDir: config.dataDir,
          port: skillPackPort,
          zipBuffer:
            ctx.zipBuffer ??
            (ctx.sourceKind === "zip" && ctx.sourceUrl
              ? Buffer.from(ctx.sourceUrl, "base64")
              : undefined),
        },
      ).catch((err: Error) => console.error(`[skill-pack] install failed for ${packId}:`, err));
    },
    triggerSync: (packId, ctx) => {
      void runSync(
        {
          packId,
          sourceKind: ctx.sourceKind,
          sourceUrl: ctx.sourceUrl,
          versionRef: ctx.versionRef,
          expectedRev: ctx.expectedRev,
        },
        { dataDir: config.dataDir, port: skillPackPort },
      ).catch((err: Error) => console.error(`[skill-pack] sync failed for ${packId}:`, err));
    },
  });

  return {
    providerSvc,
    codingAgentCatalog,
    refreshOmaProviderEnv,
    omaAcpArgv,
    harnessCatalog,
    servedModelKnowledge,
    skillPackPort,
    skillPackSvc,
  };
}
