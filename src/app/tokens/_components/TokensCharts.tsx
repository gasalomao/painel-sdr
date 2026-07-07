"use client";

import { useMemo } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
  Cell,
} from "recharts";
import { formatBRL, formatTokens, SOURCE_META } from "@/lib/token-format";

/** Daily cost stacked chart — recharts wrapper, imported via next/dynamic */
export function DailyCostChart({
  byDayStacked,
  brlRate,
}: {
  byDayStacked: Array<{
    day: string;
    total: number;
    cost: number;
    calls: number;
    agent: number;
    disparo: number;
    followup: number;
    organizer: number;
    other: number;
  }>;
  brlRate: number;
}) {
  const chartData = useMemo(
    () =>
      byDayStacked.map((d) => ({
        ...d,
        agent_brl: d.agent * brlRate,
        disparo_brl: d.disparo * brlRate,
        followup_brl: d.followup * brlRate,
        organizer_brl: d.organizer * brlRate,
        other_brl: d.other * brlRate,
      })),
    [byDayStacked, brlRate]
  );

  if (byDayStacked.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground italic">
        Sem dados no período.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
        <XAxis
          dataKey="day"
          stroke="#ffffff60"
          fontSize={10}
          tickFormatter={(d: string) => d.slice(5)}
        />
        <YAxis
          stroke="#ffffff60"
          fontSize={10}
          tickFormatter={(v: number) => `R$ ${Number(v).toFixed(2)}`}
          width={60}
        />
        <Tooltip
          contentStyle={{
            background: "#0a0a0a",
            border: "1px solid #ffffff20",
            borderRadius: 8,
            fontSize: 11,
          }}
          formatter={(v: any, name: any) => {
            const key = String(name).replace("_brl", "");
            const meta = SOURCE_META[key] || SOURCE_META.other;
            return [formatBRL(Number(v)), meta.label];
          }}
          labelFormatter={(d: any) => `📅 ${String(d)}`}
        />
        <Legend
          wrapperStyle={{ fontSize: 10 }}
          formatter={(v: string) => {
            const key = String(v).replace("_brl", "");
            return SOURCE_META[key]?.label || key;
          }}
        />
        <Bar dataKey="agent_brl" stackId="a" fill={SOURCE_META.agent.color} />
        <Bar dataKey="disparo_brl" stackId="a" fill={SOURCE_META.disparo.color} />
        <Bar dataKey="followup_brl" stackId="a" fill={SOURCE_META.followup.color} />
        <Bar dataKey="organizer_brl" stackId="a" fill={SOURCE_META.organizer.color} />
        <Bar
          dataKey="other_brl"
          stackId="a"
          fill={SOURCE_META.other.color}
          radius={[4, 4, 0, 0]}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Top sources horizontal bar chart — recharts wrapper, imported via next/dynamic */
export function TopSourcesChart({
  bySourceLabel,
  brlRate,
}: {
  bySourceLabel: Array<{
    source: string;
    label: string;
    total: number;
    cost: number;
    calls: number;
  }>;
  brlRate: number;
}) {
  const chartData = useMemo(
    () =>
      bySourceLabel.slice(0, 10).map((s) => ({
        ...s,
        cost_brl: s.cost * brlRate,
      })),
    [bySourceLabel, brlRate]
  );

  if (chartData.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-muted-foreground italic">
        Sem dados.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ left: 110, right: 20 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
        <XAxis
          type="number"
          stroke="#ffffff60"
          fontSize={10}
          tickFormatter={(v: number) => `R$ ${Number(v).toFixed(2)}`}
        />
        <YAxis
          type="category"
          dataKey="label"
          stroke="#ffffff60"
          fontSize={10}
          width={140}
        />
        <Tooltip
          contentStyle={{
            background: "#0a0a0a",
            border: "1px solid #ffffff20",
            borderRadius: 8,
            fontSize: 11,
          }}
          formatter={(v: any) => formatBRL(Number(v))}
        />
        <Bar dataKey="cost_brl" radius={[0, 4, 4, 0]}>
          {chartData.map((s, i) => (
            <Cell
              key={i}
              fill={SOURCE_META[s.source]?.color || "#94a3b8"}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
