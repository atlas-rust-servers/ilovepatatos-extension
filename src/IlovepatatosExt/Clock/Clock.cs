﻿using JetBrains.Annotations;
using Oxide.Core.Plugins;

namespace Oxide.Ext.IlovepatatosExt;

[UsedImplicitly(ImplicitUseTargetFlags.WithMembers)]
public class Clock : Callback
{
    public static Clock New(Plugin owner = null)
    {
        var clock = PoolUtility.Get<Clock>();
        clock.PluginOwner = owner;

        return clock;
    }

    [Obsolete($"Use {nameof(New)} instead.")]
    public static Clock Create(Plugin owner = null) => New(owner);
}