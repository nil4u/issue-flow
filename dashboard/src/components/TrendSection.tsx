'use client';

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { formatDuration } from '@/lib/format.ts';
import type { TrendPoint } from '@/lib/queries.ts';

function durationTick(value: number) {
  return formatDuration(value);
}

function percentTick(value: number) {
  return `${Math.round(value * 100)}%`;
}

export function TrendSection({ points }: { points: TrendPoint[] }) {
  return (
    <section className="section">
      <div className="section-header">
        <div>
          <h2>趋势图</h2>
          <p>最近 30 个自然日 · 按 Issue 创建时间分桶。</p>
        </div>
      </div>
      <div className="trend-grid">
        <div className="chart-card">
          <h3>Issue 创建与完成趋势</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={points} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7ef" />
              <XAxis dataKey="short_label" tick={{ fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="completed" name="已完成 Issue 数" stackId="issue" fill="#4f46e5" />
              <Bar dataKey="unfinished" name="未完成 Issue 数" stackId="issue" fill="#b76b12" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h3>Issue 完成时长</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={points} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7ef" />
              <XAxis dataKey="short_label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={durationTick} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value) => formatDuration(Number(value))} />
              <Legend />
              <Line type="linear" dataKey="first_close_p50" name="P50" stroke="#159163" dot={false} connectNulls={false} />
              <Line type="linear" dataKey="first_close_p75" name="P75" stroke="#b76b12" dot={false} connectNulls={false} />
              <Line type="linear" dataKey="first_close_p90" name="P90" stroke="#c3382c" dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h3>新增 Bug 占比趋势</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={points} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7ef" />
              <XAxis dataKey="short_label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={percentTick} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value) => (value == null ? '-' : `${(Number(value) * 100).toFixed(1)}%`)} />
              <Line type="linear" dataKey="new_bug_ratio" name="新增 Bug 占比" stroke="#c3382c" dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="chart-card">
          <h3>范围内累计 Bug 占比趋势</h3>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={points} margin={{ top: 12, right: 18, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7ef" />
              <XAxis dataKey="short_label" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={percentTick} tick={{ fontSize: 12 }} />
              <Tooltip formatter={(value) => (value == null ? '-' : `${(Number(value) * 100).toFixed(1)}%`)} />
              <Line type="linear" dataKey="cumulative_bug_ratio" name="累计 Bug 占比" stroke="#4f46e5" dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
