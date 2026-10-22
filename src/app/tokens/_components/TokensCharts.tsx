"use client";

import { useMemo, type JSX } from "react";
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
import { formatBRL, SOURCE_META } from "@/lib/token-format";

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
}): JSX.Element {
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
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground text-center px-4">
        Sem dados no período.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={chartData} barSize={24} accessibilityLayer>
        <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="#344138" />
        <XAxis
          dataKey="day"
          stroke="#a8b6ac"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          minTickGap={20}
          tickMargin={10}
          tickFormatter={(d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`}
        />
        <YAxis
          stroke="#a8b6ac"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          tickFormatter={(v: number) => `R$ ${Number(v).toFixed(2)}`}
          width={60}
        />
        <Tooltip
          contentStyle={{
            background: "#202b24",
            border: "1px solid #526b5b",
            borderRadius: 8,
            color: "#edf2ee",
            fontSize: 12,
          }}
          cursor={{ fill: "#a8b6ac0d" }}
          formatter={(v, name) => {
            const key = String(name).replace("_brl", "");
            const meta = SOURCE_META[key] || SOURCE_META.other;
            return [formatBRL(Number(v)), meta.label];
          }}
          labelFormatter={(d) => String(d).split("-").reverse().join("/")}
        />
        <Legend
          iconType="circle"
          iconSize={7}
          wrapperStyle={{ fontSize: 11, lineHeight: "24px", paddingTop: 12, color: "#b7c7bd" }}
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
}): JSX.Element {
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
      <div className="h-full flex items-center justify-center text-sm text-muted-foreground text-center px-4">
        Nenhum agente ou campanha com consumo neste período.
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ left: 0, right: 8, top: 4 }}
        barSize={20}
        accessibilityLayer
      >
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="#344138" />
        <XAxis
          type="number"
          stroke="#a8b6ac"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          tickFormatter={(v: number) => `R$ ${Number(v).toFixed(2)}`}
        />
        <YAxis
          type="category"
          dataKey="label"
          stroke="#a8b6ac"
          tickLine={false}
          axisLine={false}
          fontSize={11}
          width={126}
          tickFormatter={(label: string) => label.length > 18 ? `${label.slice(0, 17)}…` : label}
        />
        <Tooltip
          contentStyle={{
            background: "#202b24",
            border: "1px solid #526b5b",
            borderRadius: 8,
            color: "#edf2ee",
            fontSize: 12,
          }}
          cursor={{ fill: "#a8b6ac0d" }}
          formatter={(v) => [formatBRL(Number(v)), "Custo"]}
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
