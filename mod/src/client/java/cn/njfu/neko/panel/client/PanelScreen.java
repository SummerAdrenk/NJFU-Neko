package cn.njfu.neko.panel.client;

import cn.njfu.neko.panel.NekoPanelMod;
import cn.njfu.neko.panel.PanelMenu;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;

/** 猫娘的人物面板：左边盔甲、中间她的模型（跟着鼠标转）、副手，右边状态；下面是她的背包，再下面是自己的背包。 */
public class PanelScreen extends AbstractContainerScreen<PanelMenu> {
    private static final Identifier TEXTURE = Identifier.fromNamespaceAndPath(NekoPanelMod.MOD_ID, "textures/gui/panel.png");
    private static final int TEXT = 0xFF404040;
    private final Info info;

    public record Info(int entityId, boolean editable, String name) {
        static Info parse(Component title) {
            String marker = title.getStyle().getInsertion();
            if (marker == null || !marker.startsWith(NekoPanelMod.MARKER)) return null;
            String[] parts = marker.substring(NekoPanelMod.MARKER.length()).split("\\|", 3);
            try {
                return new Info(Integer.parseInt(parts[0]), "1".equals(parts[1]), parts.length > 2 ? parts[2] : "");
            } catch (RuntimeException e) {
                return null;
            }
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
        if (companion != null) {
            InventoryScreen.extractEntityInInventoryFollowsMouse(g, this.leftPos + 26, this.topPos + 8, this.leftPos + 75, this.topPos + 78,
                30, 0.0625F, mouseX, mouseY, companion);
        }
    }

    @Override
    protected void extractLabels(GuiGraphicsExtractor g, int mouseX, int mouseY) {
        String name = info.name().isEmpty() ? this.title.getString() : info.name();
        g.text(this.font, this.font.plainSubstrByWidth(name, 72), 98, 8, TEXT, false);
        LivingEntity companion = companion();
        if (companion != null) {
            g.text(this.font, Component.translatableWithFallback("njfu_neko_panel.health", "生命 %s/%s",
                (int) Math.ceil(companion.getHealth()), (int) companion.getMaxHealth()), 98, 22, TEXT, false);
            g.text(this.font, Component.translatableWithFallback("njfu_neko_panel.armor", "护甲 %s", companion.getArmorValue()), 98, 34, TEXT, false);
        }
        if (!info.editable()) g.text(this.font, Component.translatableWithFallback("njfu_neko_panel.read_only", "只能看，不能拿"), 98, 66, 0xFF8B2020, false);
        g.text(this.font, this.playerInventoryTitle, this.inventoryLabelX, this.inventoryLabelY, TEXT, false);
    }
}
