package cn.njfu.neko.panel;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.fabricmc.fabric.api.event.player.UseEntityCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.EntityArgument;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.SimpleMenuProvider;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;

/**
 * NJFU智慧猫娘 面板模组（服务器端，单人/局域网世界里装在自己的游戏里即可）。
 * <ul>
 *   <li>右键猫娘：打开她的背包（盔甲、副手、背包、快捷栏），可以直接拿取、放入。装了本模组的客户端显示成“人物面板”，
 *       没装的客户端显示成普通的 5 行箱子界面，一样能用。</li>
 *   <li>Shift + 右键：通知猫娘打开功能菜单。</li>
 *   <li>/njfu quiet &lt;命令&gt;：只有猫娘自己能用，执行命令时不在管理员聊天栏里留下灰色提示。</li>
 *   <li>/njfu ui &lt;动作&gt;：功能菜单的按钮用，谁都能用。panel 打开她的人物面板，其他动作转告猫娘去做。</li>
 *   <li>/njfu duel on|off &lt;玩家&gt;：决斗锁 1 滴血（只有猫娘自己能用）。决斗中的人受到致命伤害时不会死，血量锁在 1。</li>
 * </ul>
 */
public final class NekoPanelMod implements ModInitializer {
    public static final String MOD_ID = "njfu_neko_panel";
    /** 写在界面标题的 insertion 里，装了模组的客户端据此换成人物面板：前缀|实体ID|能否编辑|饱食度|名字 */
    public static final String MARKER = "njfu_neko_panel|";
    /** 决斗中的玩家 → 保护到期时间（最多 10 分钟：猫娘程序中途断了，也不会一直死不了）。 */
    private static final Map<UUID, Long> DUELISTS = new ConcurrentHashMap<>();

    @Override
    public void onInitialize() {
        PanelConfig.load();
        // 决斗锁血：决斗中的人受到致命伤害时取消死亡、血量锁在 1（这局就分出胜负了）
        ServerLivingEntityEvents.ALLOW_DEATH.register((entity, source, amount) -> allowDeath(entity));
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
                // 决斗锁血（只有猫娘自己能用）：on 之后这些玩家不会被打死，off 或 10 分钟后解除
                .then(Commands.literal("duel").requires(NekoPanelMod::isCompanionSource)
                    .then(Commands.literal("on").then(Commands.argument("players", EntityArgument.players()).executes(ctx -> duelLock(ctx, true))))
                    .then(Commands.literal("off").then(Commands.argument("players", EntityArgument.players()).executes(ctx -> duelLock(ctx, false)))))
                // 功能菜单的按钮（谁都能用）：对话框按钮只能执行命令、不能替玩家发聊天，所以由这里转告猫娘
                .then(Commands.literal("ui")
                    .then(Commands.argument("action", StringArgumentType.word())
                        .executes(ctx -> menuButton(ctx.getSource(), StringArgumentType.getString(ctx, "action")))))));
    }

    private static boolean isCompanionSource(CommandSourceStack source) {
        ServerPlayer p = source.getPlayer();
        return p != null && PanelConfig.isCompanion(p) && Commands.<CommandSourceStack>hasPermission(Commands.LEVEL_GAMEMASTERS).test(source);
    }

    private static int duelLock(CommandContext<CommandSourceStack> ctx, boolean on) throws CommandSyntaxException {
        long until = System.currentTimeMillis() + 10 * 60_000L;
        int n = 0;
        for (ServerPlayer p : EntityArgument.getPlayers(ctx, "players")) {
            if (on) DUELISTS.put(p.getUUID(), until);
            else DUELISTS.remove(p.getUUID());
            n++;
        }
        return n;
    }

    private static boolean allowDeath(LivingEntity entity) {
        if (!(entity instanceof ServerPlayer p)) return true;
        Long until = DUELISTS.get(p.getUUID());
        if (until == null) return true;
        if (until < System.currentTimeMillis()) {
            DUELISTS.remove(p.getUUID());
            return true;
        }
        p.setHealth(1.0F);
        return false;
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
