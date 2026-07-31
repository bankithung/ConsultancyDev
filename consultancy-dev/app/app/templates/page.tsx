'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/apiClient';
import type { Template } from '@/lib/types';
import { toast } from '@/store/toastStore';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { usePaginatedQuery } from '@/hooks/usePaginatedQuery';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Mail, MessageSquare, Plus, Edit, Trash2, Send, Eye, X, Copy } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';


export default function TemplatesPage() {
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  const [filterType, setFilterType] = useState('all');

  // Form State
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'Email' | 'SMS' | 'WhatsApp'>('Email');
  const [newCategory, setNewCategory] = useState<'Welcome' | 'Follow-up' | 'Document Request' | 'Payment Reminder' | 'Other'>('Follow-up');
  const [newSubject, setNewSubject] = useState('');
  const [newBody, setNewBody] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const queryClient = useQueryClient();

  const templatesQuery = usePaginatedQuery(['templates'], apiClient.templates.list, {
    ordering: 'name',
    filters: filterType === 'all' ? undefined : { type: filterType },
  });
  const templates = templatesQuery.rows;
  const isLoading = templatesQuery.isLoading;

  const createTemplateMutation = useMutation({
    mutationFn: apiClient.templates.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      setIsCreateOpen(false);
      resetForm();
      toast.success('Template created');
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: apiClient.templates.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });

  const resetForm = () => {
    setNewName('');
    setNewType('Email');
    setNewCategory('Follow-up');
    setNewSubject('');
    setNewBody('');
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    createTemplateMutation.mutate({
      name: newName,
      type: newType,
      // Only email templates carry a subject line.
      subject: newType === 'Email' ? newSubject : '',
      body: newBody,
      isActive: true,
    });
  };

  const handleDelete = (id: string) => {
    setDeleteId(id);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-pulse text-slate-500">Loading templates...</div>
      </div>
    );
  }

  // `type` is filtered server-side through the query above.
  const filteredTemplates = templates;

  const handleCopy = async (template: Template) => {
    try {
      await navigator.clipboard.writeText(template.body);
      toast.success('Template copied to clipboard');
    } catch {
      toast.error('Could not copy', 'Your browser blocked clipboard access.');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Message Templates</h1>
          <p className="text-sm text-slate-600 mt-1 font-body">Create and manage Email/SMS/WhatsApp templates</p>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="h-9 bg-teal-600 hover:bg-teal-700 font-body">
          <Plus className="mr-2 h-4 w-4" /> Create Template
        </Button>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {['all', 'Email', 'SMS', 'WhatsApp'].map(type => (
          <Button
            key={type}
            variant={filterType === type ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilterType(type)}
            className={`h-9 font-body ${filterType === type ? 'bg-teal-600' : ''}`}
          >
            {type === 'all' ? 'All Templates' : type}
          </Button>
        ))}
      </div>

      {/* Templates Grid */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {filteredTemplates.map(template => (
          <Card key={template.id} className="border-slate-200 hover:shadow-lg transition-shadow">
            <CardHeader className={`border-b border-slate-100 ${template.type === 'Email' ? 'bg-gradient-to-r from-blue-50 to-white' :
              template.type === 'SMS' ? 'bg-gradient-to-r from-green-50 to-white' :
                'bg-gradient-to-r from-purple-50 to-white'
              }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {template.type === 'Email' ? <Mail size={18} className="text-blue-600" /> :
                    template.type === 'SMS' ? <MessageSquare size={18} className="text-green-600" /> :
                      <MessageSquare size={18} className="text-purple-600" />}
                  <CardTitle className="text-base font-heading">{template.name}</CardTitle>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${template.type === 'Email' ? 'bg-blue-100 text-blue-700' :
                  template.type === 'SMS' ? 'bg-green-100 text-green-700' :
                    'bg-purple-100 text-purple-700'
                  }`}>
                  {template.type}
                </span>
              </div>
            </CardHeader>
            <CardContent className="pt-6">
              {template.subject && (
                <p className="text-sm font-semibold text-slate-900 mb-2 font-heading">{template.subject}</p>
              )}
              <p className="text-sm text-slate-600 line-clamp-3 mb-4 font-body whitespace-pre-wrap">{template.body}</p>

              <div className="flex items-center justify-between text-xs text-slate-500 mb-4 font-body">
                <span>{template.usageCount} uses</span>
              </div>

              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="flex-1 h-8 text-xs font-body" onClick={() => { setSelectedTemplate(template); setIsPreviewOpen(true); }}>
                  <Eye size={12} className="mr-1" /> Preview
                </Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0" onClick={() => handleCopy(template)}>
                  <Copy size={14} />
                </Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                  <Edit size={14} />
                </Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 hover:text-red-600" onClick={() => handleDelete(template.id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Create Template Modal */}
      <Dialog.Root open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] w-[90vw] max-w-[600px] translate-x-[-50%] translate-y-[-50%] rounded-xl bg-white p-6 shadow-xl z-50 border max-h-[90vh] overflow-y-auto">
            <Dialog.Title className="text-xl font-bold text-slate-900 mb-6 font-heading">Create Template</Dialog.Title>
            <form className="space-y-4" onSubmit={handleCreate}>
              <div className="space-y-2">
                <Label className="font-body">Template Name</Label>
                <Input
                  className="h-11"
                  placeholder="e.g., Welcome Email"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  required
                />
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label className="font-body">Type</Label>
                  <Select value={newType} onValueChange={(val: any) => setNewType(val)}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Email">Email</SelectItem>
                      <SelectItem value="SMS">SMS</SelectItem>
                      <SelectItem value="WhatsApp">WhatsApp</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="font-body">Category</Label>
                  <Select value={newCategory} onValueChange={(val: any) => setNewCategory(val)}>
                    <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="Welcome">Welcome</SelectItem>
                      <SelectItem value="Follow-up">Follow-up</SelectItem>
                      <SelectItem value="Document Request">Document Request</SelectItem>
                      <SelectItem value="Payment Reminder">Payment Reminder</SelectItem>
                      <SelectItem value="Other">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {newType === 'Email' && (
                <div className="space-y-2">
                  <Label className="font-body">Subject</Label>
                  <Input
                    className="h-11"
                    placeholder="Email subject line"
                    value={newSubject}
                    onChange={(e) => setNewSubject(e.target.value)}
                    required={newType === 'Email'}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label className="font-body">Message Body</Label>
                <textarea
                  className="w-full min-h-[120px] px-3 py-2 border border-slate-300 rounded-md focus:border-teal-500 focus:ring-1 focus:ring-teal-500 outline-none font-body"
                  placeholder="Use variables: {studentName}, {course}, {deadline}, {amount}, etc."
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  required
                />
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-xs text-blue-900 font-body">
                  <strong>Available variables:</strong> {'{studentName}'}, {'{course}'}, {'{deadline}'}, {'{amount}'}, {'{companyName}'}, {'{counselorName}'}, {'{phone}'}
                </p>
              </div>
              <div className="flex gap-3 pt-4">
                <Button variant="outline" type="button" onClick={() => setIsCreateOpen(false)} className="flex-1 h-11 font-body">Cancel</Button>
                <Button type="submit" className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 font-body" disabled={createTemplateMutation.isPending}>
                  {createTemplateMutation.isPending ? 'Creating...' : 'Create Template'}
                </Button>
              </div>
            </form>
            <Dialog.Close asChild>
              <button className="absolute top-4 right-4 p-1 rounded-full hover:bg-slate-100">
                <X size={20} />
              </button>
            </Dialog.Close>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Preview Modal */}
      <Dialog.Root open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
          <Dialog.Content className="fixed left-[50%] top-[50%] w-[90vw] max-w-[500px] translate-x-[-50%] translate-y-[-50%] rounded-xl bg-white p-6 shadow-xl z-50 border">
            {selectedTemplate && (
              <>
                <Dialog.Title className="text-xl font-bold text-slate-900 mb-4 font-heading">{selectedTemplate.name}</Dialog.Title>
                <div className="space-y-4">
                  {selectedTemplate.subject && (
                    <div>
                      <Label className="text-xs text-slate-500 font-body">Subject</Label>
                      <p className="text-sm font-semibold text-slate-900 font-heading">{selectedTemplate.subject}</p>
                    </div>
                  )}
                  <div>
                    <Label className="text-xs text-slate-500 font-body">Message</Label>
                    <div className="bg-slate-50 rounded-lg p-4 mt-2 border border-slate-200">
                      <p className="text-sm text-slate-700 whitespace-pre-wrap font-body">{selectedTemplate.body}</p>
                    </div>
                  </div>
                </div>
                <div className="flex gap-3 mt-6 pt-6 border-t">
                  <Button variant="outline" className="flex-1 h-11 font-body" onClick={() => setIsPreviewOpen(false)}>Close</Button>
                  <Button
                    className="flex-1 h-11 bg-teal-600 hover:bg-teal-700 font-body"
                    onClick={() => handleCopy(selectedTemplate)}
                  >
                    <Copy size={16} className="mr-2" /> Copy body
                  </Button>
                </div>
                <Dialog.Close asChild>
                  <button className="absolute top-4 right-4 p-1 rounded-full hover:bg-slate-100">
                    <X size={20} />
                  </button>
                </Dialog.Close>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <ConfirmDialog
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) deleteTemplateMutation.mutate(deleteId);
          setDeleteId(null);
        }}
        title="Delete template?"
        description="This template will be removed. Messages already sent are unaffected."
        confirmText="Delete"
        confirmVariant="destructive"
        isLoading={deleteTemplateMutation.isPending}
      />
    </div>
  );
}
