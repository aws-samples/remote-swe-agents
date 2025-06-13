'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

export default function DateSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations('cost');

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(
    searchParams.get('year') ? parseInt(searchParams.get('year')!) : now.getFullYear()
  );
  const [selectedMonth, setSelectedMonth] = useState(
    searchParams.get('month') ? parseInt(searchParams.get('month')!) : now.getMonth() + 1
  );

  // Generate year options (current year and previous 2 years)
  const years = Array.from({ length: 3 }, (_, i) => now.getFullYear() - i);

  // Generate months with i18n support
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: t(`monthNames.${i + 1}`),
  }));

  const updateUrl = (year: number, month: number) => {
    const params = new URLSearchParams();
    params.set('year', year.toString());
    params.set('month', month.toString());
    router.push(`/cost?${params.toString()}`);
  };

  const handleYearChange = (year: number) => {
    setSelectedYear(year);
    updateUrl(year, selectedMonth);
  };

  const handleMonthChange = (month: number) => {
    setSelectedMonth(month);
    updateUrl(selectedYear, month);
  };

  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t('period')}:</span>

        {/* Year Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-w-[100px]">
              {t('yearSuffix', { year: selectedYear })}
              <ChevronDownIcon className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {years.map((year) => (
              <DropdownMenuItem
                key={year}
                onClick={() => handleYearChange(year)}
                className={selectedYear === year ? 'bg-accent' : ''}
              >
                {t('yearSuffix', { year })}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Month Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-w-[80px]">
              {months.find((m) => m.value === selectedMonth)?.label}
              <ChevronDownIcon className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {months.map((month) => (
              <DropdownMenuItem
                key={month.value}
                onClick={() => handleMonthChange(month.value)}
                className={selectedMonth === month.value ? 'bg-accent' : ''}
              >
                {month.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
