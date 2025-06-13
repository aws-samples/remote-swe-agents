'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDownIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';

const MONTHS = [
  { value: 1, label: '1月' },
  { value: 2, label: '2月' },
  { value: 3, label: '3月' },
  { value: 4, label: '4月' },
  { value: 5, label: '5月' },
  { value: 6, label: '6月' },
  { value: 7, label: '7月' },
  { value: 8, label: '8月' },
  { value: 9, label: '9月' },
  { value: 10, label: '10月' },
  { value: 11, label: '11月' },
  { value: 12, label: '12月' },
];

export default function DateSelector() {
  const router = useRouter();
  const searchParams = useSearchParams();
  
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(
    searchParams.get('year') ? parseInt(searchParams.get('year')!) : now.getFullYear()
  );
  const [selectedMonth, setSelectedMonth] = useState(
    searchParams.get('month') ? parseInt(searchParams.get('month')!) : now.getMonth() + 1
  );

  // Generate year options (current year and previous 2 years)
  const years = Array.from({ length: 3 }, (_, i) => now.getFullYear() - i);

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
        <span className="text-sm font-medium">期間:</span>
        
        {/* Year Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-w-[100px]">
              {selectedYear}年
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
                {year}年
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Month Selector */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="min-w-[80px]">
              {MONTHS.find(m => m.value === selectedMonth)?.label}
              <ChevronDownIcon className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {MONTHS.map((month) => (
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