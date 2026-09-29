package cn.njfu.neko.panel.client;

import cn.njfu.neko.panel.NekoPanelMod;
import cn.njfu.neko.panel.PanelMenu;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.Map;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.MenuScreens;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.gui.screens.inventory.MenuAccess;
import net.minecraft.network.chat.Component;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.inventory.MenuType;
import org.slf4j.LoggerFactory;

/**
 * 客户端：服务器打开的是原版 5 行箱子，标题里带着猫娘面板的标记时，换成人物面板样式显示。
 * 其他箱子照常用原版界面。
 */
public final class NekoPanelClient implements ClientModInitializer {
    @Override
    public void onInitializeClient() {
        try {
            Field field = MenuScreens.class.getDeclaredField("SCREENS");
            field.setAccessible(true);
            @SuppressWarnings("unchecked")
            Map<MenuType<?>, Object> screens = (Map<MenuType<?>, Object>) field.get(null);
            Object original = screens.get(MenuType.GENERIC_9x5);
            Class<?> constructor = Class.forName("net.minecraft.client.gui.screens.MenuScreens$ScreenConstructor");
            Method originalCreate = constructor.getMethod("create", AbstractContainerMenu.class, Inventory.class, Component.class);
            originalCreate.setAccessible(true);
            InvocationHandler handler = (proxy, method, args) -> switch (method.getName()) {
                case "create" -> createScreen(original, originalCreate, (AbstractContainerMenu) args[0], (Inventory) args[1], (Component) args[2]);
                case "fromPacket" -> {
                    // 和原版默认实现一样：建菜单 → 建界面 → 设为当前菜单并显示
                    Minecraft mc = (Minecraft) args[2];
                    Inventory inventory = mc.player.getInventory();
                    MenuType<?> type = (MenuType<?>) args[1];
                    Screen screen = createScreen(original, originalCreate, type.create((Integer) args[3], inventory), inventory, (Component) args[0]);
                    mc.player.containerMenu = ((MenuAccess<?>) screen).getMenu();
                    mc.gui.setScreen(screen);
                    yield null;
                }
                case "hashCode" -> System.identityHashCode(proxy);
                case "equals" -> proxy == args[0];
                case "toString" -> "NJFU猫娘面板（包装原版 5 行箱子界面）";
                default -> method.invoke(original, args);
            };
            screens.put(MenuType.GENERIC_9x5, Proxy.newProxyInstance(constructor.getClassLoader(), new Class<?>[] {constructor}, handler));
        } catch (Throwable e) {
            // 出问题也不能让游戏崩溃：面板会退回成原版 5 行箱子的样子，照样能拿放东西
            LoggerFactory.getLogger("NJFU猫娘面板").warn("{}：换成人物面板样式失败，将使用原版箱子界面", NekoPanelMod.MOD_ID, e);
        }
    }

    private static Screen createScreen(Object original, Method originalCreate, AbstractContainerMenu vanilla, Inventory inventory, Component title)
        throws ReflectiveOperationException {
        PanelScreen.Info info = PanelScreen.Info.parse(title);
        if (info == null) return (Screen) originalCreate.invoke(original, vanilla, inventory, title);
        PanelMenu menu = new PanelMenu(vanilla.containerId, inventory, new SimpleContainer(PanelMenu.BOX), inventory.player, info.editable());
        return new PanelScreen(menu, inventory, title, info);
    }
}
