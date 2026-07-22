'use client';

import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { IconX } from '@tabler/icons-react';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterConfig {
  key: string;
  label: string;
  options: FilterOption[];
  value: string;
  onChange: (value: string) => void;
}

export interface FilterBarProps {
  filters: FilterConfig[];
  onClearAll?: () => void;
  className?: string;
}

export function FilterBar({ filters, onClearAll, className }: FilterBarProps) {
  const hasActiveFilter = filters.some((f) => f.value !== '' && f.value !== 'all');

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {filters.map((filter) => (
        <Select
          key={filter.key}
          value={filter.value}
          onValueChange={(value) => filter.onChange(value ?? '')}
        >
          <SelectTrigger size="sm">
            {/* Base UI renders the raw value string while the popup is closed
                (items unmounted), so value≠label filters showed "all"/"urgent"
                with no field context. Format via the value function and keep the
                field label visible so each filter stays self-describing. */}
            <SelectValue placeholder={filter.label}>
              {(value: string) => {
                if (value === '' || value === 'all') {
                  return (
                    <span className="text-muted-foreground">{filter.label}</span>
                  );
                }
                const opt = filter.options.find((o) => o.value === value);
                return (
                  <span>
                    <span className="text-muted-foreground">{filter.label}: </span>
                    {opt ? opt.label : value}
                  </span>
                );
              }}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {filter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      {hasActiveFilter && onClearAll && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="h-7 gap-1 text-xs text-muted-foreground"
        >
          <IconX className="size-3" />
          Clear filters
        </Button>
      )}
    </div>
  );
}
