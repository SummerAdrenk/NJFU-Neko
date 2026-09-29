import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import collectBlockPkg from 'mineflayer-collectblock';
import toolPkg from 'mineflayer-tool';
import pvpPkg from 'mineflayer-pvp';
import armorManager from 'mineflayer-armor-manager';
import { AUTH_DIR } from '../paths.js';

export const { pathfinder, Movements, goals } = pathfinderPkg;

export function createBot(cfg, target) {
  const bot = mineflayer.createBot({
    host: target.host,
    port: target.port,
    version: target.version,
    username: cfg.account.username,
    auth: cfg.account.auth,
    profilesFolder: AUTH_DIR,
    hideErrors: true,
    checkTimeoutInterval: 60_000,
    respawn: cfg.behavior.auto_respawn,
    // 聊天由 chat.js 按数据包类型解析，不用 mineflayer 基于正则的旧式聊天事件（容易误判系统消息）。
    defaultChatPatterns: false,
  });
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(toolPkg.plugin);
  bot.loadPlugin(collectBlockPkg.plugin);
  bot.loadPlugin(pvpPkg.plugin);
  if (cfg.behavior.auto_armor) bot.loadPlugin(armorManager);
  bot.nekoScaffold = cfg.behavior.scaffold !== false;
  // mineflayer 的物理模块在连上服务器后才装载，会把 elytraFly 换回它那个发错动作名的版本：每次进入世界再换一次
  bot.on('spawn', () => {
    bot.elytraFly = () => startGliding(bot);
  });
  return bot;
}

// “展开鞘翅”的动作：新版本（1.21.2+）叫 start_fall_flying，mineflayer 还在发旧名字 start_elytra_flying（或旧编号 8），
// 服务器解不开这个包就会把人踢掉。按当前协议里的名字发。
export function fallFlyingAction(registry) {
  const def = registry?.protocol?.play?.toServer?.types?.packet_entity_action;
  const field = Array.isArray(def) ? def[1]?.find?.((f) => f.name === 'actionId') : null;
  const mappings = Array.isArray(field?.type) && field.type[0] === 'mapper' ? field.type[1]?.mappings : null;
  if (!mappings) return 8;
  return Object.values(mappings).find((v) => /fall_flying|elytra/.test(v)) ?? null;
}

export async function startGliding(bot) {
  if (bot.entity.elytraFlying) throw new Error('已经在飞了');
  if (bot.entity.onGround) throw new Error('在地上飞不起来，要先跳起来');
  if (bot.entity.isInWater) throw new Error('在水里飞不起来');
  if (bot.inventory.slots[bot.getEquipmentDestSlot('torso')]?.name !== 'elytra') throw new Error('没穿鞘翅');
  const actionId = fallFlyingAction(bot.registry);
  if (actionId == null) throw new Error('这个版本不知道怎么展开鞘翅');
  bot._client.write('entity_action', { entityId: bot.entity.id, actionId, jumpBoost: 0 });
}

// 寻路时绝不挖开的方块：大多是玩家建筑里才有的东西。
// 只影响“走路时顺手挖开挡路方块”，明确要求 dig_block 时不受限制。
const PROTECTED = /(_planks|_stairs|_slab|_wall|_fence|_fence_gate|_door|_trapdoor|_bed|_carpet|_wool|glass|_concrete|_sign|_banner|bricks|chest|barrel|shulker_box|furnace|smoker|crafting_table|bookshelf|lantern|torch|rail|lever|_button|pressure_plate|redstone_wire|redstone_torch|redstone_block|redstone_lamp|repeater|comparator|hopper|dispenser|dropper|observer|piston|anvil|enchanting_table|brewing_stand|beacon|bell|lectern|loom|stonecutter|grindstone|cartography_table|fletching_table|smithing_table|composter|cauldron|ladder|scaffolding|flower_pot|candle|quartz_block|iron_bars|jukebox|note_block|respawn_anchor|lodestone|beehive|campfire|sea_lantern|_tiles|chiseled_|polished_|smooth_|cut_copper|copper_bulb|crafter|farmland)/;

// 可以随手垫的便宜方块（搭路、往上垫高时用）
const SCAFFOLD = /^(dirt|coarse_dirt|cobblestone|cobbled_deepslate|netherrack|andesite|diorite|granite|tuff|blackstone|end_stone|stone|deepslate|mud|basalt|calcite)$/;

// scaffold：寻路时能不能垫方块（搭桥过沟、原地垫高）。默认不垫——平时走路不放方块，只有建造和被困住走不出去时才打开（见 gotoGoal）。
export function makeMovements(bot, { dig = false, scaffold = false } = {}) {
  const moves = new Movements(bot);
  moves.canDig = dig;
  moves.allowParkour = true;
  moves.allowSprinting = true;
  // 垫方块：身上有泥土、圆石这类便宜方块时才行
  const blocks = scaffold ? bot.registry.itemsArray.filter((i) => SCAFFOLD.test(i.name)).map((i) => i.id) : [];
  moves.scafoldingBlocks = blocks;
  moves.allow1by1towers = blocks.length > 0;
  for (const block of bot.registry.blocksArray) {
    if (PROTECTED.test(block.name)) moves.blocksCantBreak.add(block.id);
  }
  return moves;
}
