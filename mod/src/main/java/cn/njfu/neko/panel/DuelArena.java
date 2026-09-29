package cn.njfu.neko.panel;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.serialization.JsonOps;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.resources.RegistryOps;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 决斗用的服务器端功能：
 * <ul>
 *   <li>锁 1 滴血：决斗中的人受到致命伤害时不会死，血量锁在 1（手上有不死图腾时让图腾正常触发，多一条命）。</li>
 *   <li>保护场地：决斗双方附近的爆炸（末影水晶、TNT）只伤人，不破坏方块。</li>
 *   <li>保管背包：决斗前把整个背包存进存档目录的文件（njfu_neko_stash/）再清空，好穿临时装备；打完原样放回。
 *       游戏中途关了也不会丢：下次进游戏自动放回。</li>
 * </ul>
 */
public final class DuelArena {
    private static final Logger LOGGER = LoggerFactory.getLogger("njfu_neko_panel");
    /** 决斗中的玩家 → 保护到期时间（最多 10 分钟：猫娘程序中途断了，也不会一直死不了）。 */
    private static final Map<UUID, Long> DUELISTS = new ConcurrentHashMap<>();
    private static final double ARENA_RADIUS = 48;

    private DuelArena() {
    }

    static void lock(ServerPlayer p, boolean on) {
        if (on) DUELISTS.put(p.getUUID(), System.currentTimeMillis() + 10 * 60_000L);
        else DUELISTS.remove(p.getUUID());
    }

    static boolean dueling(ServerPlayer p) {
        Long until = DUELISTS.get(p.getUUID());
        if (until == null) return false;
        if (until < System.currentTimeMillis()) {
            DUELISTS.remove(p.getUUID());
            return false;
        }
        return true;
    }

    /** ServerLivingEntityEvents.ALLOW_DEATH：决斗中受到致命伤害，没有图腾就把血量锁在 1。 */
    static boolean allowDeath(LivingEntity entity) {
        if (!(entity instanceof ServerPlayer p) || !dueling(p)) return true;
        if (p.getMainHandItem().is(Items.TOTEM_OF_UNDYING) || p.getOffhandItem().is(Items.TOTEM_OF_UNDYING)) return true;
        p.setHealth(1.0F);
        return false;
    }

    /** 这次爆炸在决斗双方附近吗（附近的爆炸不破坏方块）。 */
    public static boolean protects(ServerLevel level, Vec3 center) {
        if (DUELISTS.isEmpty()) return false;
        for (ServerPlayer p : level.players()) {
            if (dueling(p) && p.position().distanceToSqr(center) <= ARENA_RADIUS * ARENA_RADIUS) return true;
        }
        return false;
    }

    private static Path stashFile(MinecraftServer server, UUID id) {
        return server.getWorldPath(LevelResource.ROOT).resolve("njfu_neko_stash").resolve(id + ".json");
    }

    /** 保管：存进文件再清空。已经保管着一份（上次没还）就不覆盖。返回 saved / exists / encode_failed / io_failed。 */
    static String save(MinecraftServer server, ServerPlayer p) {
        Path file = stashFile(server, p.getUUID());
        if (Files.exists(file)) return "exists";
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess());
        Inventory inv = p.getInventory();
        JsonArray slots = new JsonArray();
        for (int i = 0; i < inv.getContainerSize(); i++) {
            ItemStack stack = inv.getItem(i);
            if (stack.isEmpty()) continue;
            JsonElement item = ItemStack.CODEC.encodeStart(ops, stack).result().orElse(null);
            if (item == null) return "encode_failed"; // 有存不下来的东西：不保管，免得丢
            JsonObject o = new JsonObject();
            o.addProperty("slot", i);
            o.add("item", item);
            slots.add(o);
        }
        JsonObject root = new JsonObject();
        root.addProperty("name", p.getName().getString());
        root.addProperty("selected", inv.getSelectedSlot());
        root.add("slots", slots);
        try {
            Files.createDirectories(file.getParent());
            Files.writeString(file, root.toString());
        } catch (IOException e) {
            LOGGER.warn("保管 {} 的背包失败", p.getName().getString(), e);
            return "io_failed";
        }
        inv.clearContent();
        return "saved";
    }

    /** 放回：清空（临时装备）后按原来的格子放回；保管文件改名留底，不删。返回 restored / none / read_failed。 */
    static String restore(MinecraftServer server, ServerPlayer p) {
        Path file = stashFile(server, p.getUUID());
        if (!Files.exists(file)) return "none";
        JsonObject root;
        try {
            root = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        } catch (Exception e) {
            LOGGER.warn("读取 {} 的保管文件失败", p.getName().getString(), e);
            return "read_failed";
        }
        RegistryOps<JsonElement> ops = RegistryOps.create(JsonOps.INSTANCE, server.registryAccess());
        Inventory inv = p.getInventory();
        inv.clearContent();
        for (JsonElement el : root.getAsJsonArray("slots")) {
            JsonObject o = el.getAsJsonObject();
            int slot = o.get("slot").getAsInt();
            ItemStack stack = ItemStack.CODEC.parse(ops, o.get("item")).result().orElse(ItemStack.EMPTY);
            if (slot >= 0 && slot < inv.getContainerSize()) inv.setItem(slot, stack);
        }
        if (root.has("selected")) inv.setSelectedSlot(root.get("selected").getAsInt());
        try {
            Files.move(file, file.resolveSibling(p.getUUID() + "-" + System.currentTimeMillis() + ".restored.json"));
        } catch (IOException e) {
            LOGGER.warn("保管文件改名失败：{}", file, e);
        }
        return "restored";
    }

    /** 进游戏时：还有没放回的保管（上次游戏中途关了），自动放回。 */
    static void onJoin(MinecraftServer server, ServerPlayer p) {
        if (!dueling(p) && Files.exists(stashFile(server, p.getUUID()))) {
            LOGGER.info("{} 进游戏：放回上次保管的背包（{}）", p.getName().getString(), restore(server, p));
        }
    }
}
