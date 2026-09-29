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
 *   <li>/njfu ui &lt;动作&gt;：功能菜单的按钮用，谁都能用。panel 打开她的人物面板，其他动作转告猫娘去做。</li>
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
                // ping、quiet 只有猫娘自己能用
                .then(Commands.literal("ping").requires(NekoPanelMod::isCompanionSource).executes(ctx -> 1))
                .then(Commands.literal("quiet").requires(NekoPanelMod::isCompanionSource)
                    .then(Commands.argument("command", StringArgumentType.greedyString()).executes(ctx -> {
                        String command = StringArgumentType.getString(ctx, "command");
                        CommandSourceStack quiet = ctx.getSource().withSuppressedOutput();
                        quiet.getServer().getCommands().performPrefixedCommand(quiet, command);
                        return 1;
                    })))
                // 功能菜单的按钮（谁都能用）：对话框按钮只能执行命令、不能替玩家发聊天，所以由这里转告猫娘
                .then(Commands.literal("ui")
                    .then(Commands.argument("action", StringArgumentType.word())
                        .executes(ctx -> menuButton(ctx.getSource(), StringArgumentType.getString(ctx, "action")))))));
    }

    private static boolean isCompanionSource(CommandSourceStack source) {
        ServerPlayer p = source.getPlayer();
        return p != null && PanelConfig.isCompanion(p) && Commands.<CommandSourceStack>hasPermission(Commands.LEVEL_GAMEMASTERS).test(source);
    }

    /** 菜单按钮：panel 在她身边时直接打开人物面板（离得远就让她弹背包窗口）；其他动作转告离自己最近的猫娘去做。 */
    private static int menuButton(CommandSourceStack source, String action) {
        ServerPlayer viewer = source.getPlayer();
        if (viewer == null) return 0;
        ServerPlayer companion = nearestCompanion(source, viewer);
        if (companion == null) {
            viewer.sendSystemMessage(Component.translatableWithFallback("njfu_neko_panel.offline", "猫娘现在不在线"));
            return 0;
        }
        if ("panel".equals(action)) {
            if (CompanionContainer.inRange(viewer, companion)) {
                openPanel(viewer, companion);
                notifyCompanion(companion, "panel", viewer);
                return 1;
            }
            action = "bag";
        }
        companion.sendSystemMessage(Component.literal("[NJFU-UI] do " + viewer.getName().getString() + " " + action));
        return 1;
    }

    private static ServerPlayer nearestCompanion(CommandSourceStack source, ServerPlayer viewer) {
        ServerPlayer best = null;
        double bestDist = Double.MAX_VALUE;
        for (ServerPlayer p : source.getServer().getPlayerList().getPlayers()) {
            if (p == viewer || !PanelConfig.isCompanion(p)) continue;
            double d = p.level() == viewer.level() ? p.distanceToSqr(viewer) : Double.MAX_VALUE / 2;
            if (best == null || d < bestDist) {
                best = p;
                bestDist = d;
            }
        }
        return best;
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
