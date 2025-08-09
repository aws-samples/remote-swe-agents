'use client';

import { Suspense } from 'react';
import { usePathname } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import ModelSettingsTab from './components/ModelSettingsTab';
import Loading from '@/components/Loading';

export default function SettingsPage() {
  const pathname = usePathname();
  const segments = pathname.split('/');
  const defaultTab = segments[segments.length - 1] === 'settings' ? 'model' : segments[segments.length - 1];

  return (
    <div className="container mx-auto py-6">
      <div className="flex flex-col">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Settings</CardTitle>
            <CardDescription>Configure your agent settings</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue={defaultTab} className="w-full">
              <TabsList className="grid w-full grid-cols-1">
                <TabsTrigger value="model">Model</TabsTrigger>
              </TabsList>
              <TabsContent value="model">
                <Suspense fallback={<Loading />}>
                  <ModelSettingsTab />
                </Suspense>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}