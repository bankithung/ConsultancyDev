/**
 * Professional printable registration receipt component
 */
'use client';

import { format } from 'date-fns';
import { Printer, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RegistrationData {
    id?: number;
    registrationNo: string;
    studentName: string;
    email: string;
    mobile: string;
    dateOfBirth?: string;
    fatherName: string;
    motherName: string;
    permanentAddress: string;
    registrationFee: number;
    paymentMethod: string;
    paymentStatus: string;
    preferences?: Array<{
        courseName: string;
        location: string;
        priority: number;
    }>;
    createdAt?: string;
}

interface RegistrationReceiptProps {
    data: RegistrationData;
    onClose: () => void;
}

export function RegistrationReceipt({ data, onClose }: RegistrationReceiptProps) {
    const handlePrint = () => {
        window.print();
    };

    const receiptDate = data.createdAt ? new Date(data.createdAt) : new Date();

    return (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
            {/* Receipt Container */}
            <div className="relative bg-white rounded-lg shadow-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto">
                {/* Close Button - Hidden when printing */}
                <button
                    onClick={onClose}
                    className="no-print absolute top-4 right-4 p-2 rounded-full hover:bg-gray-100 text-gray-400 hover:text-gray-600 z-10"
                >
                    <X size={20} />
                </button>

                {/* Print Button - Hidden when printing */}
                <div className="no-print sticky top-0 bg-white border-b border-gray-200 p-4 flex justify-between items-center">
                    <h2 className="text-lg font-semibold text-gray-900">Registration Receipt</h2>
                    <Button onClick={handlePrint} className="bg-teal-600 hover:bg-teal-700">
                        <Printer size={16} className="mr-2" />
                        Print Receipt
                    </Button>
                </div>

                {/* Receipt Content - This will be printed */}
                <div className="receipt-container p-8 md:p-12">
                    {/* Header */}
                    <div className="text-center mb-8 border-b-2 border-gray-900 pb-6">
                        <h1 className="text-2xl font-bold text-gray-900 mb-2">REGISTRATION RECEIPT</h1>
                        <p className="text-sm text-gray-600">Student Consultancy Services</p>
                    </div>

                    {/* Receipt Info Bar */}
                    <div className="grid grid-cols-1 gap-4 mb-8 text-sm sm:grid-cols-2 print:grid-cols-2">
                        <div>
                            <p className="text-gray-600">Receipt Number:</p>
                            <p className="font-mono font-bold text-gray-900">{data.registrationNo}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-gray-600">Date:</p>
                            <p className="font-semibold text-gray-900">{format(receiptDate, 'dd MMM yyyy, hh:mm a')}</p>
                        </div>
                    </div>

                    {/* Student Information */}
                    <div className="mb-6">
                        <h3 className="text-lg font-bold text-gray-900 mb-4 border-b border-gray-300 pb-2">Student Information</h3>
                        <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 print:grid-cols-2">
                            <div>
                                <p className="text-gray-600">Student Name:</p>
                                <p className="font-semibold text-gray-900">{data.studentName}</p>
                            </div>
                            <div>
                                <p className="text-gray-600">Email:</p>
                                <p className="font-semibold text-gray-900">{data.email}</p>
                            </div>
                            <div>
                                <p className="text-gray-600">Mobile:</p>
                                <p className="font-semibold text-gray-900">{data.mobile}</p>
                            </div>
                            {data.dateOfBirth && (
                                <div>
                                    <p className="text-gray-600">Date of Birth:</p>
                                    <p className="font-semibold text-gray-900">{format(new Date(data.dateOfBirth), 'dd MMM yyyy')}</p>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Parent Information */}
                    <div className="mb-6">
                        <h3 className="text-lg font-bold text-gray-900 mb-4 border-b border-gray-300 pb-2">Parent/Guardian Information</h3>
                        <div className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2 print:grid-cols-2">
                            <div>
                                <p className="text-gray-600">Father's Name:</p>
                                <p className="font-semibold text-gray-900">{data.fatherName}</p>
                            </div>
                            <div>
                                <p className="text-gray-600">Mother's Name:</p>
                                <p className="font-semibold text-gray-900">{data.motherName}</p>
                            </div>
                        </div>
                    </div>

                    {/* Address */}
                    <div className="mb-6">
                        <h3 className="text-lg font-bold text-gray-900 mb-4 border-b border-gray-300 pb-2">Address</h3>
                        <p className="text-sm text-gray-900">{data.permanentAddress}</p>
                    </div>

                    {/* Study Preferences */}
                    {data.preferences && data.preferences.length > 0 && (
                        <div className="mb-6">
                            <h3 className="text-lg font-bold text-gray-900 mb-4 border-b border-gray-300 pb-2">Study Preferences</h3>
                            <div className="space-y-2">
                                {data.preferences.map((pref, idx) => (
                                    <div key={idx} className="flex items-center text-sm">
                                        <span className="w-8 h-8 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center font-bold mr-3 text-xs">
                                            {pref.priority}
                                        </span>
                                        <div>
                                            <p className="font-semibold text-gray-900">{pref.courseName}</p>
                                            <p className="text-gray-600 text-xs">{pref.location}</p>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Payment Details */}
                    <div className="mb-8 bg-gray-50 p-6 rounded-lg border border-gray-200">
                        <h3 className="text-lg font-bold text-gray-900 mb-4">Payment Details</h3>
                        <div className="grid grid-cols-1 gap-4 text-sm mb-4 sm:grid-cols-2 print:grid-cols-2">
                            <div>
                                <p className="text-gray-600">Payment Method:</p>
                                <p className="font-semibold text-gray-900">{data.paymentMethod}</p>
                            </div>
                            <div>
                                <p className="text-gray-600">Payment Status:</p>
                                <p className={`font-semibold ${data.paymentStatus === 'Paid' ? 'text-green-600' :
                                    data.paymentStatus === 'Pending' ? 'text-yellow-600' :
                                        'text-orange-600'
                                    }`}>{data.paymentStatus}</p>
                            </div>
                        </div>
                        <div className="border-t border-gray-300 pt-4">
                            <div className="flex justify-between items-center">
                                <p className="text-lg font-bold text-gray-900">Registration Fee:</p>
                                <p className="text-2xl font-bold text-teal-600">₹{data.registrationFee.toLocaleString()}</p>
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="border-t-2 border-gray-900 pt-6 mt-8">
                        <div className="grid grid-cols-1 gap-8 mb-6 sm:grid-cols-2 print:grid-cols-2">
                            <div>
                                <p className="text-xs text-gray-600 mb-4">Terms & Conditions:</p>
                                <ul className="text-xs text-gray-600 space-y-1">
                                    <li>• This receipt is computer generated and valid</li>
                                    <li>• Registration fee is non-refundable</li>
                                    <li>• Please preserve this receipt for future reference</li>
                                </ul>
                            </div>
                            <div className="text-right">
                                <p className="text-xs text-gray-600 mb-12">Authorized Signature</p>
                                <div className="border-t border-gray-400 pt-1">
                                    <p className="text-xs text-gray-600">Authorized Signatory</p>
                                </div>
                            </div>
                        </div>
                        <div className="text-center text-xs text-gray-500">
                            <p>Thank you for choosing our services!</p>
                            <p className="mt-1">For queries, contact: support@consultancy.com | +91-XXXXXXXXXX</p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Print-specific styles */}
            <style dangerouslySetInnerHTML={{
                __html: `
                    @media print {
                        @page {
                            size: A4;
                            margin: 10mm;
                        }
                        
                        * {
                            -webkit-print-color-adjust: exact;
                            print-color-adjust: exact;
                        }
                        
                        body {
                            margin: 0 !important;
                            padding: 0 !important;
                        }
                        
                        .no-print {
                            display: none !important;
                        }
                        
                        .receipt-container {
                            box-shadow: none !important;
                            border-radius: 0 !important;
                            max-width: 100% !important;
                        }
                        
                        h3 {
                            page-break-after: avoid;
                        }
                    }
                `
            }} />
        </div>
    );
}
