'use client';

import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/shared/lib/api';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/shared/components/primitives/Tabs';
import { Button } from '@/shared/components/primitives/Button';
import { Input } from '@/shared/components/primitives/Input';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/shared/components/primitives/Sheet';
import { DataTable } from '@/features/governance/components/DataTable';
import { useResourceMutation } from '@/features/governance/hooks/useResourceMutation';
import type { ColumnDef } from '@/features/governance/types';
import { Trash2, Pencil, Search } from 'lucide-react';

/* ─── Types ─── */
interface Role {
  id: string;
  name: string;
  tenant_id: string;
  created_at: string;
  [key: string]: unknown;
}

interface Permission {
  id: string;
  resource_type: string;
  action: string;
  created_at: string;
  [key: string]: unknown;
}

interface RoleBinding {
  id: string;
  subject_id: string;
  role_id: string;
  role_name: string;
  scope_type: string;
  scope_id: string;
  created_at: string;
  [key: string]: unknown;
}

/* ─── Page Component ─── */
export default function RbacPage() {
  const qc = useQueryClient();

  /* ── Sheet state ── */
  const [roleSheetOpen, setRoleSheetOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [bindingSheetOpen, setBindingSheetOpen] = useState(false);

  /* ── Form state ── */
  const [roleName, setRoleName] = useState('');
  const [bindSubjectId, setBindSubjectId] = useState('');
  const [bindRoleId, setBindRoleId] = useState('');
  const [bindScopeType, setBindScopeType] = useState<'tenant' | 'space'>('tenant');
  const [bindScopeId, setBindScopeId] = useState('');

  /* ── Search state ── */
  const [permSearch, setPermSearch] = useState('');

  /* ── Mutations ── */
  const roleMutations = useResourceMutation({
    endpoint: '/rbac/roles',
    listQueryKey: ['/rbac/roles'],
    onSuccess: () => {
      setRoleSheetOpen(false);
      setEditingRole(null);
      setRoleName('');
    },
  });

  const bindingMutations = useResourceMutation({
    endpoint: '/rbac/bindings',
    listQueryKey: ['/rbac/bindings'],
    onSuccess: () => {
      setBindingSheetOpen(false);
      setBindSubjectId('');
      setBindRoleId('');
      setBindScopeType('tenant');
      setBindScopeId('');
    },
  });

  /* ── Queries ── */
  const rolesQuery = useQuery({
    queryKey: ['/rbac/roles'],
    queryFn: async () => {
      const res = await apiFetch('/rbac/roles');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ items: Role[]; roles: Role[] }>;
    },
  });

  const permissionsQuery = useQuery({
    queryKey: ['/rbac/permissions'],
    queryFn: async () => {
      const res = await apiFetch('/rbac/permissions');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ items: Permission[]; permissions: Permission[] }>;
    },
  });

  const bindingsQuery = useQuery({
    queryKey: ['/rbac/bindings'],
    queryFn: async () => {
      const res = await apiFetch('/rbac/bindings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{ items: RoleBinding[]; bindings: RoleBinding[] }>;
    },
  });

  /* ── Filtered permissions ── */
  const filteredPermissions = useMemo(() => {
    const items = permissionsQuery.data?.items ?? [];
    if (!permSearch.trim()) return items;
    const q = permSearch.toLowerCase();
    return items.filter(
      (p) =>
        p.resource_type.toLowerCase().includes(q) ||
        p.action.toLowerCase().includes(q),
    );
  }, [permissionsQuery.data, permSearch]);

  /* ── Handlers ── */
  const openCreateRole = () => {
    setEditingRole(null);
    setRoleName('');
    setRoleSheetOpen(true);
  };

  const openEditRole = (role: Role) => {
    setEditingRole(role);
    setRoleName(role.name);
    setRoleSheetOpen(true);
  };

  const handleRoleSubmit = async () => {
    if (!roleName.trim()) return;
    if (editingRole) {
      await roleMutations.update(editingRole.id, { name: roleName.trim() });
    } else {
      await roleMutations.create({ name: roleName.trim() });
    }
  };

  const handleDeleteRole = (role: Role) => {
    if (confirm(`确认删除角色「${role.name}」？此操作将同时移除关联的权限和绑定。`)) {
      roleMutations.remove(role.id);
    }
  };

  const openCreateBinding = () => {
    setBindSubjectId('');
    setBindRoleId('');
    setBindScopeType('tenant');
    setBindScopeId('');
    setBindingSheetOpen(true);
  };

  const handleBindingSubmit = async () => {
    if (!bindSubjectId.trim() || !bindRoleId.trim() || !bindScopeId.trim()) return;
    await bindingMutations.create({
      subjectId: bindSubjectId.trim(),
      roleId: bindRoleId.trim(),
      scopeType: bindScopeType,
      scopeId: bindScopeId.trim(),
    });
  };

  const handleDeleteBinding = (binding: RoleBinding) => {
    if (confirm('确认移除此绑定关系？')) {
      bindingMutations.remove(binding.id);
    }
  };

  /* ── Columns: Roles ── */
  const roleColumns: ColumnDef<Role>[] = [
    { key: 'name', label: '角色名称', sortable: true },
    { key: 'id', label: '角色 ID', hiddenOnMobile: true },
    {
      key: 'created_at', label: '创建时间', hiddenOnMobile: true,
      render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-',
    },
  ];

  const roleColumnsWithActions: ColumnDef<Role>[] = [
    ...roleColumns,
    {
      key: 'id' as keyof Role & string, label: '操作', width: '120px',
      render: (_v, row) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); openEditRole(row); }}>
            <Pencil className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteRole(row); }}>
            <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />
          </Button>
        </div>
      ),
    },
  ];

  /* ── Columns: Permissions ── */
  const permissionColumns: ColumnDef<Permission>[] = [
    { key: 'resource_type', label: '所属模块', sortable: true },
    { key: 'action', label: '权限动作', sortable: true },
    {
      key: 'created_at', label: '注册时间', hiddenOnMobile: true,
      render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-',
    },
  ];

  /* ── Columns: Bindings ── */
  const bindingColumns: ColumnDef<RoleBinding>[] = [
    { key: 'subject_id', label: '用户 ID' },
    { key: 'role_name', label: '角色名称' },
    { key: 'scope_type', label: '作用域类型' },
    { key: 'scope_id', label: '作用域 ID', hiddenOnMobile: true },
    {
      key: 'created_at', label: '绑定时间', hiddenOnMobile: true,
      render: (v) => v ? new Date(v as string).toLocaleString('zh-CN') : '-',
    },
  ];

  const bindingColumnsWithActions: ColumnDef<RoleBinding>[] = [
    ...bindingColumns,
    {
      key: 'id' as keyof RoleBinding & string, label: '操作', width: '100px',
      render: (_v, row) => (
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); handleDeleteBinding(row); }}>
            <Trash2 className="h-4 w-4 text-[var(--color-danger)]" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="bg-[var(--color-surface)] min-h-screen">
      <div className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        <h1 className="text-[var(--text-lg)] font-semibold text-[var(--color-text)]">
          角色权限管理
        </h1>

        <Tabs defaultValue="roles">
          <TabsList>
            <TabsTrigger value="roles">角色管理</TabsTrigger>
            <TabsTrigger value="permissions">权限一览</TabsTrigger>
            <TabsTrigger value="bindings">用户绑定</TabsTrigger>
          </TabsList>

          {/* ─── Tab 1: 角色管理 ─── */}
          <TabsContent value="roles">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button size="sm" onClick={openCreateRole}>新建角色</Button>
              </div>
              <DataTable<Role>
                columns={roleColumnsWithActions}
                data={rolesQuery.data?.items ?? []}
                loading={rolesQuery.isLoading}
                emptyMessage="暂无角色数据"
              />
            </div>
          </TabsContent>

          {/* ─── Tab 2: 权限一览 ─── */}
          <TabsContent value="permissions">
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-full sm:w-64">
                  <Input
                    placeholder="搜索权限（模块/动作）…"
                    value={permSearch}
                    onChange={(e) => setPermSearch(e.target.value)}
                    prefix={<Search className="h-4 w-4" />}
                  />
                </div>
              </div>
              <DataTable<Permission>
                columns={permissionColumns}
                data={filteredPermissions}
                loading={permissionsQuery.isLoading}
                emptyMessage="暂无权限数据"
              />
            </div>
          </TabsContent>

          {/* ─── Tab 3: 用户绑定 ─── */}
          <TabsContent value="bindings">
            <div className="space-y-4">
              <div className="flex items-center justify-end">
                <Button size="sm" onClick={openCreateBinding}>添加绑定</Button>
              </div>
              <DataTable<RoleBinding>
                columns={bindingColumnsWithActions}
                data={bindingsQuery.data?.items ?? []}
                loading={bindingsQuery.isLoading}
                emptyMessage="暂无绑定数据"
              />
            </div>
          </TabsContent>
        </Tabs>

        {/* ─── Sheet: 新建/编辑角色 ─── */}
        <Sheet open={roleSheetOpen} onOpenChange={setRoleSheetOpen}>
          <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
            <SheetHeader>
              <SheetTitle>{editingRole ? '编辑角色' : '新建角色'}</SheetTitle>
              <SheetDescription>
                {editingRole ? '修改角色名称' : '创建一个新的 RBAC 角色'}
              </SheetDescription>
            </SheetHeader>
            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => { e.preventDefault(); handleRoleSubmit(); }}
            >
              <label className="block space-y-1">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                  角色名称 *
                </span>
                <Input
                  value={roleName}
                  onChange={(e) => setRoleName(e.target.value)}
                  placeholder="如 admin、editor、viewer"
                  required
                />
              </label>
              <div className="flex justify-end pt-4">
                <Button type="submit" loading={roleMutations.isLoading}>
                  {editingRole ? '保存' : '创建'}
                </Button>
              </div>
            </form>
          </SheetContent>
        </Sheet>

        {/* ─── Sheet: 添加用户绑定 ─── */}
        <Sheet open={bindingSheetOpen} onOpenChange={setBindingSheetOpen}>
          <SheetContent side="right" className="w-full max-w-md overflow-y-auto">
            <SheetHeader>
              <SheetTitle>添加用户-角色绑定</SheetTitle>
              <SheetDescription>将用户绑定到指定角色</SheetDescription>
            </SheetHeader>
            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => { e.preventDefault(); handleBindingSubmit(); }}
            >
              <label className="block space-y-1">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                  用户 ID *
                </span>
                <Input
                  value={bindSubjectId}
                  onChange={(e) => setBindSubjectId(e.target.value)}
                  placeholder="Subject ID"
                  required
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                  角色 ID *
                </span>
                <Input
                  value={bindRoleId}
                  onChange={(e) => setBindRoleId(e.target.value)}
                  placeholder="Role ID"
                  required
                />
              </label>
              <label className="block space-y-1">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                  作用域类型 *
                </span>
                <select
                  className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-[var(--text-sm)] text-[var(--color-text)] focus:outline-none focus:ring-1 focus:ring-[var(--color-border-focus)]"
                  value={bindScopeType}
                  onChange={(e) => setBindScopeType(e.target.value as 'tenant' | 'space')}
                >
                  <option value="tenant">Tenant</option>
                  <option value="space">Space</option>
                </select>
              </label>
              <label className="block space-y-1">
                <span className="text-[var(--text-sm)] font-medium text-[var(--color-text-secondary)]">
                  作用域 ID *
                </span>
                <Input
                  value={bindScopeId}
                  onChange={(e) => setBindScopeId(e.target.value)}
                  placeholder="Tenant ID 或 Space ID"
                  required
                />
              </label>
              <div className="flex justify-end pt-4">
                <Button type="submit" loading={bindingMutations.isLoading}>
                  绑定
                </Button>
              </div>
            </form>
          </SheetContent>
        </Sheet>
      </div>
    </div>
  );
}
