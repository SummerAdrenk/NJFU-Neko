package cn.njfu.neko.panel;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.world.entity.player.Player;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * 配置文件 config/njfu_neko_panel.json：
 * companions 哪些玩家是猫娘（默认 NJFU_Neko；也可以给玩家加 njfu_companion 标签）；
 * owners 谁能从她背包里拿放东西（留空 = 所有人，其他人只能看）；display_name 面板上显示的名字。
 */
final class PanelConfig {
    private static final Logger LOG = LoggerFactory.getLogger("NJFU猫娘面板");
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Set<String> COMPANIONS = new HashSet<>(Set.of("njfu_neko"));
    private static final Set<String> OWNERS = new HashSet<>();
    private static String displayName = "NJFU智慧猫娘";

    private PanelConfig() {
    }

    static void load() {
        Path file = FabricLoader.getInstance().getConfigDir().resolve("njfu_neko_panel.json");
        try {
            if (!Files.exists(file)) {
                JsonObject def = new JsonObject();
                JsonArray companions = new JsonArray();
                companions.add("NJFU_Neko");
                def.add("companions", companions);
                def.add("owners", new JsonArray());
                def.addProperty("display_name", displayName);
                Files.createDirectories(file.getParent());
                Files.writeString(file, GSON.toJson(def), StandardCharsets.UTF_8);
                return;
            }
            JsonObject json = GSON.fromJson(Files.readString(file, StandardCharsets.UTF_8), JsonObject.class);
            if (json.has("companions")) {
                COMPANIONS.clear();
                json.getAsJsonArray("companions").forEach(e -> COMPANIONS.add(e.getAsString().toLowerCase(Locale.ROOT)));
            }
            if (json.has("owners")) json.getAsJsonArray("owners").forEach(e -> OWNERS.add(e.getAsString().toLowerCase(Locale.ROOT)));
            if (json.has("display_name")) displayName = json.get("display_name").getAsString();
        } catch (IOException | RuntimeException e) {
            LOG.warn("读取 {} 失败，使用默认设置：{}", file, e.toString());
        }
    }

    static boolean isCompanion(Player player) {
        return COMPANIONS.contains(player.getName().getString().toLowerCase(Locale.ROOT)) || player.entityTags().contains("njfu_companion");
    }

    static boolean canEdit(Player viewer) {
        return OWNERS.isEmpty() || OWNERS.contains(viewer.getName().getString().toLowerCase(Locale.ROOT));
    }

    static String displayName() {
        return displayName;
    }
}
