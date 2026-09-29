package cn.njfu.neko.panel.mixin;

import cn.njfu.neko.panel.DuelArena;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ServerExplosion;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 决斗双方附近的爆炸（末影水晶、TNT）只伤人，不破坏方块，也不打掉画、物品展示框这类东西。 */
@Mixin(ServerExplosion.class)
public abstract class ServerExplosionMixin {
    @Shadow
    @Final
    private ServerLevel level;

    @Shadow
    @Final
    private Vec3 center;

    @Inject(method = "interactsWithBlocks", at = @At("HEAD"), cancellable = true)
    private void njfu$keepBlocks(CallbackInfoReturnable<Boolean> cir) {
        if (DuelArena.protects(this.level, this.center)) cir.setReturnValue(false);
    }

    @Inject(method = "shouldAffectBlocklikeEntities", at = @At("HEAD"), cancellable = true)
    private void njfu$keepBlocklike(CallbackInfoReturnable<Boolean> cir) {
        if (DuelArena.protects(this.level, this.center)) cir.setReturnValue(false);
    }
}
