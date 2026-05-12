'use client';

import type { Metric } from 'web-vitals';

const VITALS_ENDPOINT = '/api/vitals'; // Next.js API route 代理到后端

// 阈值定义
const THRESHOLDS: Record<string, number> = {
  LCP: 2500,
  INP: 200,
  CLS: 0.1,
  FCP: 1800,
  TTFB: 800,
};

function sendToBackend(metric: Metric): void {
  const body = JSON.stringify({
    name: metric.name,
    value: metric.value,
    delta: metric.delta,
    id: metric.id,
    rating: metric.rating,
    navigationType: metric.navigationType,
  });

  // 使用 sendBeacon 确保页面卸载时也能发送
  if (navigator.sendBeacon) {
    navigator.sendBeacon(VITALS_ENDPOINT, body);
  } else {
    fetch(VITALS_ENDPOINT, { method: 'POST', body, keepalive: true });
  }
}

function logToConsole(metric: Metric): void {
  const threshold = THRESHOLDS[metric.name];
  const isOverThreshold = threshold && metric.value > threshold;
  const prefix = isOverThreshold ? '⚠️' : '✅';
  console.log(
    `${prefix} [Web Vitals] ${metric.name}: ${metric.value.toFixed(2)} (${metric.rating})`,
  );
}

export async function initVitals(): Promise<void> {
  const { onLCP, onINP, onCLS, onFCP, onTTFB } = await import('web-vitals');

  const handler = (metric: Metric) => {
    if (process.env.NODE_ENV === 'development') {
      logToConsole(metric);
    } else {
      sendToBackend(metric);
    }
  };

  onLCP(handler);
  onINP(handler);
  onCLS(handler);
  onFCP(handler);
  onTTFB(handler);
}
