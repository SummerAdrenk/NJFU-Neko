package cn.njfu.neko.panel;

import com.mojang.brigadier.arguments.StringArgumentType;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.player.Player;

/**
 * NJFU智慧猫娘 面板模组（服务器端，单人/局域网世界里装在自己的游戏里即可）。
 * <ul>
 *   <li>右键猫娘：打开她的背包（盔甲、副手、背包、快捷栏），可以直接拿取、放入。装了本模组的客户端显示成“人物面板”，
 *       没装的客户端显示成普通的 5 行箱子界面，一样能用。</li>
 *   <li>Shift + 右键：通知猫娘打开功能菜单。</li>
 *   <li>/njfu quiet &lt;命令&gt;：只有猫娘自己能用，执行命令时不在管理员聊天栏里留下灰色提示。</li>
 * </ul>
 */
public final class NekoPanelMod implements ModInitializer {
    public static final String MOD_ID = "njfu_neko_panel";
    /** 写在界面标题的 insertion 里，装了模组的客户端据此换成人物面板：前缀|实体ID|能否编辑|饱食度|名字 */
    public static final String MARKER = "njfu_neko_panel|";

    @Override
    public void onInitialize() {
        PanelConfig.load();
        UseEntityCallback.EVENT.register((player, level, hand, entity, hit) -> {
            if (hand != InteractionHand.MAIN_HAND || !(entity instanceof Player target) || !PanelConfig.isCompanion(target)) {
                return InteractionResult.PASS;
            }
            if (level.isClientSide()) return InteractionResult.SUCCESS;
            if (!(player instanceof ServerPlayer viewer) || !(target instanceof ServerPlayer companion)) return InteractionResult.PASS;
            if (viewer.isShiftKeyDown()) {
                notifyCompanion(companion, "menu", viewer);
                return InteractionResult.SUCCESS;
            }
            openPanel(viewer, companion);
            notifyCompanion(companion, "panel", viewer);
            return InteractionResult.SUCCESS;
        });
        CommandRegistrationCallback.EVENT.register((dispatcher, context, selection) -> dispatcher.register(
            Commands.literal("njfu")
                .requires(NekoPanelMod::isCompanionSource)
                .then(Commands.literal("ping").executes(ctx -> 1))
                .then(Commands.literal("quiet").then(Commands.argument("command", StringArgumentType.greedyString()).executes(ctx -> {
                    String command = StringArgumentType.getString(ctx, "command");
                    CommandSourceStack quiet = ctx.getSource().withSuppressedOutput();
                    quiet.getServer().getCommands().performPrefixedCommand(quiet, command);
                    return 1;
                })))));
    }

    private static boolean isCompanionSource(CommandSourceStack source) {
        ServerPlayer p = source.getPlayer();
        return p != null && PanelConfig.isCompanion(p) && Commands.<CommandSourceStack>hasPermission(Commands.LEVEL_GAMEMASTERS).test(source);
    }

    public static void openPanel(ServerPlayer viewer, ServerPlayer companion) {
        boolean editable = PanelConfig.canEdit(viewer);
        String name = PanelConfig.displayName();
        // 饱食度原版不会发给别的玩家，打开面板时带过去：前缀|实体ID|能否编辑|饱食度|名字
        String marker = MARKER + companion.getId() + "|" + (editable ? 1 : 0) + "|" + companion.getFoodData().getFoodLevel() + "|" + name;
        Component title = Component.translatableWithFallback("njfu_neko_panel.title", "%s 的背包", name)
            .withStyle(style -> style.withInsertion(marker));
        viewer.openMenu(new SimpleMenuProvider(
            (id, inventory, p) -> new PanelMenu(id, inventory, new CompanionContainer(companion), companion, editable), title));
    }

    /** 只发给猫娘自己看的系统消息，猫娘程序据此做出反应（看向玩家、打开菜单）。 */
    private static void notifyCompanion(ServerPlayer companion, String action, ServerPlayer viewer) {
        companion.sendSystemMessage(Component.literal("[NJFU-UI] " + action + " " + viewer.getName().getString()));
    }
}
