package cn.njfu.neko.panel;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

/**
 * 把猫娘的背包映射成 45 格（和原版 5 行箱子一致，没装模组的客户端也能直接显示）：
 * 0～26 背包、27～35 快捷栏、36～39 头盔/胸甲/护腿/靴子、40 副手、41～44 空着不能用。
 */
final class CompanionContainer implements Container {
    static final int SIZE = 45;
    private final ServerPlayer companion;
    private final Inventory inventory;

    CompanionContainer(ServerPlayer companion) {
        this.companion = companion;
        this.inventory = companion.getInventory();
    }

    /** 面板格子 → 玩家背包下标（背包：0～8 快捷栏，9～35 背包，36 靴子，37 护腿，38 胸甲，39 头盔，40 副手）。 */
    static int toInventory(int slot) {
        if (slot < 27) return 9 + slot;
        if (slot < 36) return slot - 27;
        if (slot < 40) return 39 - (slot - 36);
        if (slot == 40) return 40;
        return -1;
    }

    @Override
    public int getContainerSize() {
        return SIZE;
    }

    @Override
    public boolean isEmpty() {
        return inventory.isEmpty();
    }

    @Override
    public ItemStack getItem(int slot) {
        int i = toInventory(slot);
        return i < 0 ? ItemStack.EMPTY : inventory.getItem(i);
    }

    @Override
    public ItemStack removeItem(int slot, int count) {
        int i = toInventory(slot);
        return i < 0 ? ItemStack.EMPTY : inventory.removeItem(i, count);
    }

    @Override
    public ItemStack removeItemNoUpdate(int slot) {
        int i = toInventory(slot);
        return i < 0 ? ItemStack.EMPTY : inventory.removeItemNoUpdate(i);
    }

    @Override
    public void setItem(int slot, ItemStack stack) {
        int i = toInventory(slot);
        if (i >= 0) inventory.setItem(i, stack);
    }

    @Override
    public void setChanged() {
        inventory.setChanged();
    }

    @Override
    public boolean stillValid(Player player) {
        return !companion.isRemoved() && companion.isAlive() && player.level() == companion.level() && player.distanceToSqr(companion) <= 64.0;
    }

    @Override
    public void clearContent() {
        // 不允许一键清空猫娘的背包
    }
}
