﻿using System.Collections;
using System.Collections.Concurrent;
using System.Diagnostics;
using JetBrains.Annotations;
using Oxide.Core;
using UnityEngine;
using Parallel = UnityEngine.Parallel;

namespace Oxide.Ext.IlovepatatosExt;

[UsedImplicitly(ImplicitUseTargetFlags.WithMembers)]
public static class MapUtility
{
    public const int TERRAIN_MASK = (1 << (int)Rust.Layer.Default) | (1 << (int)Rust.Layer.World) |
                                    (1 << (int)Rust.Layer.Terrain) | (1 << (int)Rust.Layer.Prevent_Movement);

    public const int TERRAIN_ENTITY_MASK = (1 << (int)Rust.Layer.Default) | (1 << (int)Rust.Layer.World) |
                                           (1 << (int)Rust.Layer.Construction) | (1 << (int)Rust.Layer.Terrain) |
                                           (1 << (int)Rust.Layer.Transparent) | (1 << (int)Rust.Layer.Vehicle_Large) |
                                           (1 << (int)Rust.Layer.Tree);

    private const float MAX_DELAY = 30f;
    private static int s_Count;

    public static string ToGrid(Vector3 pos)
    {
        var half = new Vector2(pos.x + World.Size / 2f, pos.z + World.Size / 2f);
        int maxGridSize = Mathf.FloorToInt(World.Size / 146.3f) - 1;

        int x = Mathf.FloorToInt(half.x / 146.3f);
        int y = Mathf.FloorToInt(half.y / 146.3f);

        int num1 = Mathf.Clamp(x, 0, maxGridSize);
        int num2 = Mathf.Clamp(maxGridSize - y, 0, maxGridSize);

        string extraA = num1 > 25 ? $"{(char)('A' + (num1 / 26 - 1))}" : string.Empty;
        return $"{extraA}{(char)('A' + num1 % 26)}{num2}";
    }

    public static float GetTerrainHeightAt(Vector3 pos, float yOffset = 10, float range = 1000f, int mask = TERRAIN_MASK)
    {
        float water = TerrainMeta.WaterMap.GetHeight(pos);

        Vector3 offset = new(0, yOffset, 0);
        if (!TransformUtil.GetGroundInfo(pos + offset, out RaycastHit hit, range, mask))
            return Mathf.Max(pos.y, water);

        return Mathf.Max(hit.point.y, water);
    }

    public static bool ContainsTopologyAt(Vector3 pos, TerrainTopology.Enum topology)
    {
        int layer = TerrainMeta.TopologyMap.GetTopology(pos);
        return layer.ContainsTopology(topology);
    }

    /// <summary>
    /// Create spawn points on a topology inside a rect at a given position and size.
    /// </summary>
    /// <returns>Returns a list of locations and the time it took in milliseconds.</returns>
    public static void CreateSpawnPointsOnTopology(Vector3 center, float lenght,
        TerrainTopology.Enum targetTopology, int maxAmount, Action<List<Vector3>, long> onComplete)
    {
        Rect rect = CreateRectAt(center, lenght);
        var watch = Stopwatch.StartNew();

        IEnumerator task = GetAllAvailableSpawnPointsWithin(rect, targetTopology, locations =>
        {
            List<Vector3> list = locations.ToPooledList();

            uint seed = (uint)new System.Random().Next();
            list.Shuffle(seed);

            var values = new List<Vector3>(maxAmount);

            foreach (Vector3 x in list.Take(maxAmount))
            {
                Vector3 pos = x;
                pos.y = GetTerrainHeightAt(pos, 1000);
                values.Add(pos);
            }

            PoolUtility.Free(ref list);

            watch.Stop();
            onComplete?.Invoke(values, watch.ElapsedMilliseconds);
        });

        CoroutineUtility.StartCoroutine(task);
    }

    private static Rect CreateRectAt(Vector3 center, float lenght)
    {
        var initial = new Vector2(center.x, center.z);
        Vector2 topLeftCorner = initial + new Vector2(-lenght, lenght);
        Vector2 bottomRightCorner = initial + new Vector2(lenght, -lenght);

        var pos = new Vector2(topLeftCorner.x, bottomRightCorner.y);
        var size = new Vector2(bottomRightCorner.x - topLeftCorner.x, topLeftCorner.y - bottomRightCorner.y);
        return new Rect(pos, size);
    }

    private static IEnumerator GetAllAvailableSpawnPointsWithin(Rect rect, TerrainTopology.Enum targetTopology,
        Action<ConcurrentBag<Vector3>> onComplete)
    {
        int xMin = (int)rect.xMin;
        int xMax = (int)rect.xMax;
        int yMin = (int)rect.yMin;
        int yMax = (int)rect.yMax;

        int size = (xMax - xMin) * (yMax - yMin);
        var list = new ConcurrentBag<Vector3>();

        s_Count = 0;
        TimeSince timeSince = 0;

        Parallel.For(0, Math.Abs(xMax - xMin), x =>
        {
            for (int z = yMin; z < yMax; z++)
            {
                Interlocked.Increment(ref s_Count);

                var pos = new Vector3(x + xMin, 0, z);
                int topology = TerrainMeta.TopologyMap.GetTopology(pos);

                if (!topology.ContainsTopology(targetTopology))
                    continue;

                list.Add(pos);
            }
        });

        while (s_Count < size && timeSince < MAX_DELAY)
            yield return null;

        Interface.Oxide.NextTick(() => onComplete.Invoke(list)); // NextTick() to bring back on main thread
    }
}