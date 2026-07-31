"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

interface SearchableSelectProps {
    options: { value: string; label: string }[];
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
}

export function SearchableSelect({ options, value, onChange, placeholder = "Select...", disabled = false }: SearchableSelectProps) {
    const [open, setOpen] = React.useState(false);
    const [searchTerm, setSearchTerm] = React.useState("");
    const wrapperRef = React.useRef<HTMLDivElement>(null);

    // Update search term when value changes (e.g. initial load or selection)
    React.useEffect(() => {
        const selectedOption = options.find(o => o.value === value);
        if (selectedOption) {
            setSearchTerm(selectedOption.label);
        } else if (!value) {
            setSearchTerm("");
        }
    }, [value, options]);

    // Handle clicking outside to close
    React.useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
                setOpen(false);
                // On blur, if the text doesn't match a value, reset it to the selected value
                const selectedOption = options.find(o => o.value === value);
                if (selectedOption) {
                    setSearchTerm(selectedOption.label);
                } else if (!value) {
                    setSearchTerm("");
                }
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [value, options]);

    const filteredOptions = options.filter(option =>
        option.label.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <div className="relative" ref={wrapperRef}>
            <div className="relative">
                <Input
                    placeholder={placeholder}
                    value={searchTerm}
                    onChange={(e) => {
                        setSearchTerm(e.target.value);
                        setOpen(true);
                        if (e.target.value === "") {
                            onChange("");
                        }
                    }}
                    onFocus={() => setOpen(true)}
                    disabled={disabled}
                    className="pl-9 pr-8 bg-white border-slate-200 focus:border-teal-500 focus:ring-teal-500 transition-all font-medium"
                />
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />

                {value && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onChange("");
                            setSearchTerm("");
                            setOpen(true); // Keep open to allow picking distinct
                        }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600 rounded-full hover:bg-slate-100"
                    >
                        <X size={14} />
                    </button>
                )}
                {!value && (
                    <ChevronsUpDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 opacity-50 pointer-events-none" />
                )}
            </div>

            {open && (
                <div className="absolute top-full left-0 w-full z-50 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl max-h-[200px] overflow-y-auto animate-in fade-in-0 zoom-in-95 duration-100">
                    {filteredOptions.length === 0 ? (
                        <div className="p-3 text-center text-xs text-slate-500">
                            No results found.
                        </div>
                    ) : (
                        <div className="py-1">
                            {filteredOptions.map((option) => (
                                <div
                                    key={option.value}
                                    className={cn(
                                        "px-3 py-2 text-sm cursor-pointer hover:bg-slate-50 flex items-center justify-between transition-colors",
                                        value === option.value && "bg-slate-50 font-medium text-teal-700"
                                    )}
                                    onClick={() => {
                                        onChange(option.value);
                                        setSearchTerm(option.label);
                                        setOpen(false);
                                    }}
                                >
                                    <span>{option.label}</span>
                                    {value === option.value && <Check className="h-4 w-4" />}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
