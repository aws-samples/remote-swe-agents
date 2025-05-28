import { getSession } from '@/lib/auth';
import Header from '@/components/Header';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { MessageSquare, Bot, Zap } from 'lucide-react';

export default async function Home() {
  const { userId } = await getSession();
  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <Header />

      <main className="flex-grow">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <div className="text-center py-16">
            <Bot className="w-16 h-16 text-blue-600 dark:text-blue-400 mx-auto mb-6" />
            <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-4">
              Remote SWE Agents
            </h1>
            <p className="text-xl text-gray-600 dark:text-gray-300 mb-8 max-w-2xl mx-auto">
              AIエージェントと対話して、ソフトウェア開発タスクを効率的に進めましょう。
              リアルタイムでコード作成、デバッグ、レビューが可能です。
            </p>
            
            <div className="flex flex-col sm:flex-row gap-4 justify-center mb-12">
              <Link href="/sessions">
                <Button size="lg" className="flex items-center gap-2">
                  <MessageSquare className="w-5 h-5" />
                  AIエージェントと対話
                </Button>
              </Link>
              <Link href="/sessions/new">
                <Button variant="outline" size="lg" className="flex items-center gap-2">
                  <Zap className="w-5 h-5" />
                  新しいセッション
                </Button>
              </Link>
            </div>

            <div className="grid md:grid-cols-3 gap-8 text-left">
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">🔧 コード開発</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  ファイルの作成・編集、バグ修正、機能追加など、様々な開発タスクをAIがサポート
                </p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">⚡ リアルタイム</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  進捗状況をリアルタイムで確認。ツール実行やコマンド結果を即座に表示
                </p>
              </div>
              <div className="bg-white dark:bg-gray-800 p-6 rounded-lg border border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">🚀 高機能</h3>
                <p className="text-gray-600 dark:text-gray-300">
                  GitHub連携、PR作成、テスト実行など、本格的な開発ワークフローに対応
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
