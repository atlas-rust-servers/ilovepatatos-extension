﻿using JetBrains.Annotations;
using Rust;

namespace Oxide.Ext.IlovepatatosExt;

[UsedImplicitly(ImplicitUseTargetFlags.WithMembers)]
public static class HitInfoEx
{
    [MustUseReturnValue]
    public static bool IsSuicide(this HitInfo info)
    {
        return info.damageTypes.GetMajorityDamageType() == DamageType.Suicide;
    }
}