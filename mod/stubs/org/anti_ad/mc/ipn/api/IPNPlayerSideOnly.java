package org.anti_ad.mc.ipn.api;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 只用来编译的替身：Inventory Profiles Next（一键整理模组）的注解，标在界面上表示“只整理玩家自己那一侧”。
 * 不会打包进模组 jar；运行时装了 IPN 就由 IPN 识别，没装就被忽略。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface IPNPlayerSideOnly {
}
