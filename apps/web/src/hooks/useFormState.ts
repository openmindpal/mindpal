"use client";

import { useCallback, useState } from "react";

export interface UseFormStateOptions<F extends Record<string, unknown>> {
  /** 表单字段初始值 */
  initial: F;
  /** 提交处理函数 */
  onSubmit?: (fields: F) => Promise<void>;
}

export interface FormState<F extends Record<string, unknown>> {
  fields: F;
  errors: Partial<Record<keyof F | "_form", string>>;
  busy: boolean;
  setField: <K extends keyof F>(key: K, value: F[K]) => void;
  setError: (key: keyof F | "_form", msg: string) => void;
  clearErrors: () => void;
  reset: () => void;
  submit: () => Promise<void>;
  runAction: (fn: () => Promise<unknown>) => Promise<void>;
}

/**
 * useFormState — 通用表单状态管理 Hook
 *
 * 封装 fields / errors / busy / submit 模式，
 * 统一 gov 页面的表单操作模式。
 */
export function useFormState<F extends Record<string, unknown>>(options: UseFormStateOptions<F>): FormState<F> {
  const { initial, onSubmit } = options;
  const [fields, setFields] = useState<F>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof F | "_form", string>>>({});
  const [busy, setBusy] = useState(false);

  const setField = useCallback(<K extends keyof F>(key: K, value: F[K]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  }, []);

  const setError = useCallback((key: keyof F | "_form", msg: string) => {
    setErrors((prev) => ({ ...prev, [key]: msg }));
  }, []);

  const clearErrors = useCallback(() => setErrors({}), []);

  const reset = useCallback(() => {
    setFields(initial);
    setErrors({});
    setBusy(false);
  }, [initial]);

  const runAction = useCallback(async (fn: () => Promise<unknown>) => {
    setErrors({});
    setBusy(true);
    try {
      await fn();
    } catch (err: any) {
      setErrors({ _form: typeof err === "string" ? err : err?.message ?? "Error" } as any);
    } finally {
      setBusy(false);
    }
  }, []);

  const submit = useCallback(async () => {
    if (!onSubmit) return;
    await runAction(() => onSubmit(fields));
  }, [fields, onSubmit, runAction]);

  return { fields, errors, busy, setField, setError, clearErrors, reset, submit, runAction };
}
