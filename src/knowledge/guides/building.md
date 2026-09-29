# 建造技巧

## 规划
- 先确定位置和朝向（以主人给的坐标为原点，或站在主人身边用 get_status 看坐标）。
- 列出要放的方块和数量；生存模式先用 knowledge craft_plan 算材料，采集/合成够了再动手。
- 大的建筑分层建：地基 → 墙 → 屋顶 → 门窗 → 装饰。build 一次最多 512 个方块。

## 常见方块状态
- 楼梯 `oak_stairs[facing=F,half=bottom|top,shape=straight]`：facing 是高的那一面所在方向（往 F 走是上楼）。屋顶用两排相对的楼梯。
- 台阶 `oak_slab[type=bottom|top|double]`。
- 门要放两格：`oak_door[half=lower,facing=F,hinge=left]` 和上面一格 `oak_door[half=upper,facing=F,hinge=left]`。
- 床要放两格：`red_bed[part=foot,facing=F]`，床头在 F 方向相邻的那格 `red_bed[part=head,facing=F]`。
- 原木 `oak_log[axis=x|y|z]`：横着放用 x 或 z。
- 玻璃板 `glass_pane`、栅栏 `oak_fence` 放好后会自动连接相邻的（命令模式放完可能需要再触发一次更新）。
- 火把：立着 `torch`，墙上 `wall_torch[facing=F]`（F 为背离墙的方向）。

## 小技巧
- 室内每 7～8 格放一个光源，防止刷怪。
- 用 inspect_area 检查建好的部分；发现放错用 build 覆盖（命令模式）或 dig_block 拆掉重放。
- 建在主人的地盘上之前先确认位置，别挡住别人的建筑或路。
- 有现成的投影原理图时优先用 schematic（info 看材料，build 建造）。
