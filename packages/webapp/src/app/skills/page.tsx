import HeaderWithPreferences from '@/components/HeaderWithPreferences';
import { getTranslations } from 'next-intl/server';
import PreferenceSection from '../preferences/components/PreferenceSection';
import { listUserSkills } from '@/actions/skill/action';
import SkillList from './components/SkillList';
import SkillUploadForm from './components/SkillUploadForm';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const t = await getTranslations('skills');
  const result = await listUserSkills();
  const skills = result?.data ?? [];

  return (
    <div className="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
      <HeaderWithPreferences />

      <main className="flex-grow container max-w-6xl mx-auto px-4 py-6 pt-20">
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">{t('title')}</h1>
          <p className="text-gray-600 dark:text-gray-400">{t('description')}</p>
        </div>

        <div className="space-y-6">
          <PreferenceSection title={t('upload.title')} description={t('upload.description')}>
            <SkillUploadForm existingSkillNames={skills.map((s) => ({ name: s.name, SK: s.SK }))} />
          </PreferenceSection>

          <PreferenceSection title={t('list.title')} description={t('list.description')}>
            <SkillList initialSkills={skills} />
          </PreferenceSection>
        </div>
      </main>
    </div>
  );
}
