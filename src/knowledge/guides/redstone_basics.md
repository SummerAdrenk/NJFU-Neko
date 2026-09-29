# 红石基础（Java 版）

## 信号
- 信号强度 0～15。红石粉每传一格减 1，传 15 格就没了；中继器把信号恢复到 15。
- 1 红石刻 = 2 游戏刻 = 0.1 秒。
- 强充能：信号源直接充能的方块（拉杆/按钮所附着的方块、中继器/比较器指向的方块、红石火把正上方的方块）。强充能的方块能激活旁边的红石粉。
- 弱充能：红石粉指向或压在上面的方块。弱充能只能激活旁边的元件（活塞、灯、火把等），不能激活红石粉。
- 透明方块（玻璃、台阶、楼梯、树叶、红石块以外的非完整方块）不能被充能，信号不穿过它们。
- 红石粉可以沿着方块一格一格往上爬（台阶状），但上面那格被实心方块挡住时断开。

## 方向
north = z 负方向，south = z 正方向，west = x 负方向，east = x 正方向，up = y+，down = y−。

## 元件的方块状态（/setblock、build 的写法）
- 红石粉 `redstone_wire[north=side,south=side,east=none,west=none,power=0]`：每个方向 none / side / up。build 工具写 `redstone_wire` 不带参数会自动算连接。
- 中继器 `repeater[facing=F,delay=1..4,locked=false]`：信号从 F 方向输入、从反方向输出。例：信号由西向东流 → `repeater[facing=west]`。delay 为 1～4 红石刻。侧面被另一个中继器/比较器充能时会被锁住（locked）。
- 比较器 `comparator[facing=F,mode=compare|subtract]`：后端从 F 方向输入，另一端输出，两侧为比较输入。compare 模式：后端 ≥ 侧面最大值时输出后端强度，否则 0；subtract 模式：输出 后端 − 侧面最大值。后端对着箱子、漏斗、熔炉等容器时，按容器装满程度输出 0～15。
- 侦测器 `observer[facing=F]`：“脸”朝 F 方向，看着 F 方向相邻的那一格；那一格发生任何变化，就从背面（F 的反方向）输出一个 2 游戏刻的脉冲。
- 活塞 `piston[facing=F,extended=false]` / 粘性活塞 `sticky_piston[...]`：向 F 方向推。最多推 12 个方块；推不动黑曜石、基岩、箱子/熔炉/漏斗等带方块实体的方块；粘液块、蜂蜜块会把相邻方块一起带走。准连接：Java 版活塞在它“上面一格的位置”被充能时也会伸出（但要有方块更新才触发）。
- 投掷器 `dropper[facing=F]` / 发射器 `dispenser[facing=F]`：出口朝 F。
- 漏斗 `hopper[facing=F,enabled=true]`：F 为 down 或水平方向，物品往 F 方向传；被充能时锁住（enabled=false）。每 0.4 秒传 1 个物品。
- 红石火把：立在方块上用 `redstone_torch`，贴在方块侧面用 `redstone_wall_torch[facing=F]`（F 为背离墙的方向）。所附着的方块被充能时熄灭——这就是非门。短时间内反复开关会烧坏。
- 拉杆 `lever[face=floor|wall|ceiling,facing=F,powered=false]`；按钮 `stone_button[...]`（石按钮 1 秒，木按钮 1.5 秒）；压力板 `stone_pressure_plate`。
- 红石块 `redstone_block`：一直输出 15，可被活塞推动。
- 红石灯 `redstone_lamp[lit=false]`；目标方块 `target`；阳光探测器 `daylight_detector[inverted=false]`。
- 铜灯 `waxed_copper_bulb[lit=false]`（1.21+）：每收到一次信号上升沿就切换亮灭，可以当 T 触发器；比较器读取亮着的铜灯输出 15。涂蜡防止氧化变暗。
- 合成器 `crafter[orientation=...]`（1.21+）：收到脉冲就按配方合成一次。
- 门 `oak_door[half=lower,facing=F,hinge=left]` 和上半 `oak_door[half=upper,...]` 要分别放；铁门、铁活板门只能用红石打开。

## 放置时的朝向（亲手放置时）
- 中继器、比较器、熔炉、箱子：放下时“正面”朝向玩家，所以 facing = 玩家朝向的反方向。
- 活塞、投掷器、发射器：推出/出口方向朝向玩家（facing = 玩家朝向的反方向，可朝上下）。
- 侦测器：脸朝玩家看的方向（facing = 玩家朝向）。
- 漏斗：朝向被点击的那个方块。墙上的火把、按钮贴在被点击的面上。
- build 工具会自动处理这些；用命令模式最准确。

## 建造顺序建议
先放实心方块，再放贴附类（火把、按钮、拉杆、中继器），红石粉最后放。放完用 inspect_area 检查状态，再拉拉杆/按按钮测试。
