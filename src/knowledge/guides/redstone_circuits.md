# 常用红石电路

坐标都是相对坐标（以 (0,0,0) 为原点），建造时加上实际位置。所有红石元件下面都要有实心方块垫着（y=-1 那一层先铺好石头）。

## 非门（反相器）
输入有信号时输出没有，反之亦然。信号由西向东：
- (0,0,0) redstone_wire（输入）
- (1,0,0) stone
- (2,0,0) redstone_wall_torch[facing=east]（贴在 (1,0,0) 的东面）
- (3,0,0) redstone_wire（输出）

## 或门
两条红石线汇到同一条线上即可（任一有信号，输出就有信号）。

## 与门（两个输入都有信号才输出）
- (0,0,0) stone，上面 (0,1,0) redstone_torch
- (0,0,1) stone，上面 (0,1,1) redstone_wire
- (0,0,2) stone，上面 (0,1,2) redstone_torch
- (1,0,1) redstone_wall_torch[facing=east]（输出）
- 输入 A：(-1,0,0) redstone_wire；输入 B：(-1,0,2) redstone_wire
原理：任一输入没信号 → 对应火把亮 → 中间红石粉有电 → 输出火把熄灭；两个都有信号时两个火把都灭，输出火把才亮。

## 延长信号 / 延时
每隔不超过 15 格放一个中继器；中继器 delay 调 1～4 可以延时，串联多个延时更长。

## 侦测器时钟（最快的时钟）
- (0,0,0) observer[facing=east]
- (1,0,0) observer[facing=west]
两个侦测器脸对脸，放好就会一直互相触发，从 (-1,0,0) 和 (2,0,0) 两端输出快速脉冲。拆掉一个或用活塞推开即可停止。

## T 触发器（按一下开、再按一下关）——铜灯版（1.21+）
- (0,0,0) waxed_copper_bulb
- (0,1,0) stone_button[face=floor,facing=north]（按钮按在铜灯上面）
- (1,0,0) comparator[facing=west]（读取铜灯）
- (2,0,0) redstone_wire（输出，灯亮时有信号）

## 物品满了报警 / 读取容器
比较器后端对着箱子或漏斗（comparator 的 facing 指向容器那一侧），输出强度随装满程度变化；接红石灯或音符盒提醒。

## 活塞门、农场、刷怪塔、分类仓库等复杂机器
不要凭空设计：
1. 先用 schematic list 看主人的投影原理图里有没有现成的（例如 储物/ 目录下的分类仓库、打包机）。
2. 没有的话用 knowledge wiki 查 Wiki 上的教程，按教程里的具体结构来建。
3. 建好后用 inspect_area 逐个核对元件状态，再测试。
