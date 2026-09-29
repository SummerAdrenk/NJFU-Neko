# Carpet（地毯模组）常用命令

使用前确认【服务器】里检测到了 Carpet；这些命令一般需要管理员权限。

## 假人 /player
- `/player 名字 spawn`：在自己的位置召唤一个假人（名字要唯一，建议 bot_ 开头）。可加 `at x y z facing 水平角 俯仰角 in minecraft:overworld`。
- `/player 名字 kill`：移除假人。 `/player 名字 stop`：停止它正在做的动作。
- `/player 名字 attack continuous`：一直攻击（刷怪塔挂机）；`attack interval 20` 每 20 游戏刻一次；`attack once` 一次。
- `/player 名字 use continuous`：一直右键（钓鱼、放方块等）。
- `/player 名字 look north|south|east|west|up|down` 或 `look at x y z`；`turn left|right|back`。
- `/player 名字 move forward|backward|left|right`、`jump`、`sneak`、`unsneak`、`sprint`。
- `/player 名字 drop all`、`dropStack`、`hotbar 1～9` 切换快捷栏、`swapHands`。
- `/player 名字 mount` / `dismount`。
- 需要规则 commandPlayer 允许（`/carpet commandPlayer ops`）。

## 统计与调试
- `/counter`：配合规则 `hopperCounters true`，把漏斗接在羊毛上，按羊毛颜色统计物品速率；`/counter 颜色 reset` 重置，`/counter 颜色 realtime` 实时。
- `/log tps`、`/log mobcaps`、`/log counter 颜色`：在 Tab 列表显示信息；`/log clear` 关闭。
- `/spawn mobcaps`：各类生物数量上限情况；`/spawn tracking start` … `stop` 统计刷怪速度。
- `/tick rate 20`（游戏速度）、`/tick freeze`（暂停）、`/tick step 10`、`/tick sprint 1000`（1.20.3+ 原版也有 /tick）。
- `/info block x y z`：方块详细信息；`/distance from x y z to x y z`：测距。

## 规则 /carpet
- `/carpet list` 查看规则；`/carpet 规则名 值` 修改；`/carpet setDefault 规则名 值` 设为默认。
- 常用：`commandPlayer`（假人命令）、`hopperCounters`（漏斗计数器）、`flippinCactus true`（用仙人掌右键旋转方块，修正朝向很方便）、`stackableShulkerBoxes`、`lagFreeSpawning`、`optimizedTNT`。
- 改规则影响整个服务器，要先征得主人同意。

## Gugle Carpet Addition（GCA）
增强了假人：可以打开假人的背包、让假人自动补货等。具体命令不确定时用 knowledge wiki 或让主人说明。
