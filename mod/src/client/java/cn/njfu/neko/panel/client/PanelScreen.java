package cn.njfu.neko.panel.client;

import cn.njfu.neko.panel.NekoPanelMod;
import cn.njfu.neko.panel.PanelMenu;
import java.lang.reflect.Method;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Pose;
import net.minecraft.world.entity.player.Inventory;
import org.anti_ad.mc.ipn.api.IPNPlayerSideOnly;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/**
 * 猫娘的人物面板：左边盔甲、中间她的模型（跟着鼠标转，不显示头顶名牌）、副手；右边名字和生命、护甲、饱食度图标；
 * 下面是她的背包，再下面是自己的背包。
 * 标了 IPNPlayerSideOnly：一键整理模组只整理自己的背包，不会动她的盔甲和东西。
 */
@IPNPlayerSideOnly
public class PanelScreen extends AbstractContainerScreen<PanelMenu> {
    private static final Identifier TEXTURE = Identifier.fromNamespaceAndPath(NekoPanelMod.MOD_ID, "textures/gui/panel.png");
    private static final Identifier[] HEART = sprites("hud/heart/container", "hud/heart/half", "hud/heart/full");
    private static final Identifier[] ARMOR = sprites("hud/armor_empty", "hud/armor_half", "hud/armor_full");
    private static final Identifier[] FOOD = sprites("hud/food_empty", "hud/food_half", "hud/food_full");
    private static final int TEXT = 0xFF404040;
    private static final int ICON_X = 97;
    private static final int ROW_HEALTH = 20;
    private static final int ROW_ARMOR = 31;
    private static final int ROW_FOOD = 42;
    private static final Method EXTRACT_STATE = findExtractState();
    private final Info info;

    public record Info(int entityId, boolean editable, int food, String name) {
        static Info parse(Component title) {
            String marker = title.getStyle().getInsertion();
            if (marker == null || !marker.startsWith(NekoPanelMod.MARKER)) return null;
            String[] parts = marker.substring(NekoPanelMod.MARKER.length()).split("\\|", 4);
            try {
                int food = parts.length > 3 ? Integer.parseInt(parts[2]) : -1;
                String name = parts.length > 3 ? parts[3] : parts.length > 2 ? parts[2] : "";
                return new Info(Integer.parseInt(parts[0]), "1".equals(parts[1]), food, name);
            } catch (RuntimeException e) {
                return null;
            }
        }
    }

    private static Identifier[] sprites(String empty, String half, String full) {
        return new Identifier[] {Identifier.withDefaultNamespace(empty), Identifier.withDefaultNamespace(half), Identifier.withDefaultNamespace(full)};
    }

    private static Method findExtractState() {
        try {
            Method m = InventoryScreen.class.getDeclaredMethod("extractRenderState", LivingEntity.class);
            m.setAccessible(true);
            return m;
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }

    public PanelScreen(PanelMenu menu, Inventory inventory, Component title, Info info) {
        super(menu, inventory, title, 176, 256);
        this.info = info;
        this.inventoryLabelX = 8;
        this.inventoryLabelY = 163;
    }

    private LivingEntity companion() {
        if (this.minecraft == null || this.minecraft.level == null) return null;
        Entity e = this.minecraft.level.getEntity(info.entityId());
        return e instanceof LivingEntity living ? living : null;
    }

    @Override
    public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float partialTick) {
        super.extractBackground(g, mouseX, mouseY, partialTick);
        g.blit(RenderPipelines.GUI_TEXTURED, TEXTURE, this.leftPos, this.topPos, 0.0F, 0.0F, this.imageWidth, this.imageHeight, 256, 256);
        LivingEntity companion = companion();
        if (companion != null) drawModel(g, this.leftPos + 26, this.topPos + 8, this.leftPos + 75, this.topPos + 78, 30, 0.0625F, mouseX, mouseY, companion);
        int x = this.leftPos + ICON_X;
        if (companion != null) {
            iconRow(g, HEART, x, this.topPos + ROW_HEALTH, companion.getHealth());
            iconRow(g, ARMOR, x, this.topPos + ROW_ARMOR, companion.getArmorValue());
        }
        if (info.food() >= 0) iconRow(g, FOOD, x, this.topPos + ROW_FOOD, info.food());
    }

    // 10 个图标一行：每 2 点一个满图标，1 点半个
    private static void iconRow(GuiGraphicsExtractor g, Identifier[] icons, int x, int y, float value) {
        int points = Math.max(0, Math.min(20, (int) Math.ceil(value)));
        for (int i = 0; i < 10; i++) {
            int left = points - i * 2;
            g.blitSprite(RenderPipelines.GUI_TEXTURED, icons[0], x + i * 7, y, 9, 9);
            if (left >= 2) g.blitSprite(RenderPipelines.GUI_TEXTURED, icons[2], x + i * 7, y, 9, 9);
            else if (left == 1) g.blitSprite(RenderPipelines.GUI_TEXTURED, icons[1], x + i * 7, y, 9, 9);
        }
    }

    // 和原版背包里画自己一样（跟着鼠标转），只是去掉头顶的名牌
    private static void drawModel(GuiGraphicsExtractor g, int x1, int y1, int x2, int y2, int scale, float yOffset, float mouseX, float mouseY, LivingEntity entity) {
        if (EXTRACT_STATE == null) {
            InventoryScreen.extractEntityInInventoryFollowsMouse(g, x1, y1, x2, y2, scale, yOffset, mouseX, mouseY, entity);
            return;
        }
        try {
            float cx = (x1 + x2) / 2.0F;
            float cy = (y1 + y2) / 2.0F;
            float yaw = (float) Math.atan((cx - mouseX) / 40.0F);
            float pitch = (float) Math.atan((cy - mouseY) / 40.0F);
            Quaternionf rotation = new Quaternionf().rotateZ((float) Math.PI);
            Quaternionf camera = new Quaternionf().rotateX(pitch * 20.0F * ((float) Math.PI / 180.0F));
            rotation.mul(camera);
            EntityRenderState state = (EntityRenderState) EXTRACT_STATE.invoke(null, entity);
            state.nameTag = null;
            state.scoreText = null;
            if (state instanceof LivingEntityRenderState living) {
                living.bodyRot = 180.0F + yaw * 20.0F;
                living.yRot = yaw * 20.0F;
                living.xRot = living.pose != Pose.FALL_FLYING ? -pitch * 20.0F : 0.0F;
                living.boundingBoxWidth /= living.scale;
                living.boundingBoxHeight /= living.scale;
                living.scale = 1.0F;
            }
            Vector3f translation = new Vector3f(0.0F, state.boundingBoxHeight / 2.0F + yOffset, 0.0F);
            g.entity(state, (float) scale, translation, rotation, camera, x1, y1, x2, y2);
        } catch (ReflectiveOperationException | RuntimeException e) {
            InventoryScreen.extractEntityInInventoryFollowsMouse(g, x1, y1, x2, y2, scale, yOffset, mouseX, mouseY, entity);
        }
    }

    @Override
    protected void extractLabels(GuiGraphicsExtractor g, int mouseX, int mouseY) {
        String name = info.name().isEmpty() ? this.title.getString() : info.name();
        g.text(this.font, this.font.plainSubstrByWidth(name, 74), ICON_X, 8, TEXT, false);
        if (!info.editable()) g.text(this.font, Component.translatableWithFallback("njfu_neko_panel.read_only", "只能看，不能拿"), ICON_X, 64, 0xFF8B2020, false);
        g.text(this.font, this.playerInventoryTitle, this.inventoryLabelX, this.inventoryLabelY, TEXT, false);
    }

    @Override
    public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float partialTick) {
        super.extractRenderState(g, mouseX, mouseY, partialTick);
        // 鼠标移到图标上显示具体数值
        int x = mouseX - this.leftPos;
        int y = mouseY - this.topPos;
        LivingEntity companion = companion();
        if (x < ICON_X || x > ICON_X + 72 || companion == null) return;
        Component tip = null;
        if (y >= ROW_HEALTH && y < ROW_HEALTH + 9) {
            tip = Component.translatableWithFallback("njfu_neko_panel.health", "生命 %s/%s", (int) Math.ceil(companion.getHealth()), (int) companion.getMaxHealth());
        } else if (y >= ROW_ARMOR && y < ROW_ARMOR + 9) {
            tip = Component.translatableWithFallback("njfu_neko_panel.armor", "护甲 %s", companion.getArmorValue());
        } else if (y >= ROW_FOOD && y < ROW_FOOD + 9 && info.food() >= 0) {
            tip = Component.translatableWithFallback("njfu_neko_panel.food", "饱食度 %s/20（打开面板时）", info.food());
        }
        if (tip != null) g.setTooltipForNextFrame(tip, mouseX, mouseY);
    }
}
