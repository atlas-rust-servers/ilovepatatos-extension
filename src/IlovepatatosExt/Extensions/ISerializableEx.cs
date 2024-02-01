﻿using JetBrains.Annotations;
using Newtonsoft.Json;
using Oxide.Ext.IlovepatatosExt.Interfaces;

namespace Oxide.Ext.IlovepatatosExt;

// ReSharper disable once InconsistentNaming
[UsedImplicitly(ImplicitUseTargetFlags.WithMembers)]
public static class ISerializableEx
{
    public static T Clone<T>(this T obj) where T : ISerializable
    {
        string json = JsonConvert.SerializeObject(obj);
        return JsonConvert.DeserializeObject<T>(json);
    }
}