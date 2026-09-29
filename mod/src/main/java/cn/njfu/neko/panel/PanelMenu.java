package cn.njfu.neko.panel;

import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.ArmorSlot;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.inventory.Slot;
import net.minecraft.world.item.ItemStack;

/**
 * 猫娘面板。类型用原版的 5 行箱子（GENERIC_9x5），格子顺序和原版箱子完全一致：
 * 0～44 猫娘（见 {@link CompanionContainer}），45～71 自己的背包，72～80 自己的快捷栏。
 * 服务器端和装了模组的客户端都用这个类；坐标按“人物面板”排布（没装模组的客户端用原版箱子的坐标，不影响）。
 */
public class PanelMenu extends AbstractContainerMenu {
    public static final int BOX = CompanionContainer.SIZE;
    private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};
    private static final Identifier[] ARMOR_ICONS = {
        InventoryMenu.EMPTY_ARMOR_SLOT_HELMET, InventoryMenu.EMPTY_ARMOR_SLOT_CHESTPLATE,
        InventoryMenu.EMPTY_ARMOR_SLOT_LEGGINGS, InventoryMenu.EMPTY_ARMOR_SLOT_BOOTS,
    };

    private final Container box;
    public final boolean editable;

    public PanelMenu(int id, Inventory viewer, Container box, LivingEntity armorOwner, boolean editable) {
        super(MenuType.GENERIC_9x5, id);
        this.box = box;
        this.editable = editable;
        // 猫娘的背包 3 行 + 快捷栏
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 9; col++) addSlot(new Gated(box, col + row * 9, 8 + col * 18, 84 + row * 18));
        }
        for (int col = 0; col < 9; col++) addSlot(new Gated(box, 27 + col, 8 + col * 18, 142));
        // 盔甲（头盔、胸甲、护腿、靴子）和副手
        for (int i = 0; i < 4; i++) {
            addSlot(new ArmorSlot(box, armorOwner, ARMOR[i], 36 + i, 8, 8 + i * 18, ARMOR_ICONS[i]) {
                @Override
                public boolean mayPlace(ItemStack stack) {
                    return PanelMenu.this.editable && super.mayPlace(stack);
                }

                @Override
                public boolean mayPickup(Player player) {
                    return PanelMenu.this.editable && super.mayPickup(player);
                }
            });
        }
        addSlot(new Gated(box, 40, 77, 62) {
            @Override
            public Identifier getNoItemIcon() {
                return InventoryMenu.EMPTY_ARMOR_SLOT_SHIELD;
            }
        });
        // 41～44：凑满 5 行的空位，不能放东西，也不显示
        for (int i = 41; i < BOX; i++) addSlot(new Disabled(box, i));
        // 自己的背包
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 9; col++) addSlot(new Slot(viewer, col + row * 9 + 9, 8 + col * 18, 174 + row * 18));
        }
        for (int col = 0; col < 9; col++) addSlot(new Slot(viewer, col, 8 + col * 18, 232));
    }

    @Override
    public boolean stillValid(Player player) {
        return box.stillValid(player);
    }

    @Override
    public ItemStack quickMoveStack(Player player, int index) {
        Slot slot = this.slots.get(index);
        if (!editable || slot == null || !slot.hasItem()) return ItemStack.EMPTY;
        ItemStack stack = slot.getItem();
        ItemStack original = stack.copy();
        if (index < BOX) {
            // 从猫娘身上拿到自己背包
            if (!this.moveItemStackTo(stack, BOX, this.slots.size(), true)) return ItemStack.EMPTY;
        } else {
            // 给猫娘：能穿的先穿上，否则放进她的背包
            boolean moved = false;
            for (int k = 36; k < 40 && !moved; k++) {
                Slot armor = this.slots.get(k);
                if (!armor.hasItem() && armor.mayPlace(stack)) moved = this.moveItemStackTo(stack, k, k + 1, false);
            }
            if (!moved && !this.moveItemStackTo(stack, 0, 36, false)) return ItemStack.EMPTY;
        }
        if (stack.isEmpty()) slot.setByPlayer(ItemStack.EMPTY);
        else slot.setChanged();
        if (stack.getCount() == original.getCount()) return ItemStack.EMPTY;
        slot.onTake(player, stack);
        return original;
    }

    /** 只有主人能拿放；其他人只能看。 */
    private class Gated extends Slot {
        Gated(Container container, int index, int x, int y) {
            super(container, index, x, y);
        }

        @Override
        public boolean mayPlace(ItemStack stack) {
            return editable && super.mayPlace(stack);
        }

        @Override
        public boolean mayPickup(Player player) {
            return editable && super.mayPickup(player);
        }
    }

    private static final class Disabled extends Slot {
        Disabled(Container container, int index) {
            super(container, index, -2000, -2000);
        }

        @Override
        public boolean mayPlace(ItemStack stack) {
            return false;
        }

        @Override
        public boolean mayPickup(Player player) {
            return false;
        }

        @Override
        public boolean isActive() {
            return false;
        }
    }
}
