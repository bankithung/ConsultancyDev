import Link from "next/link";
import { BarChart3, FileText, CreditCard, Bell, Download, Eye, Upload, CheckCircle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from 'date-fns';

export default function StudentPortalPage() {
  // Mock student data
  const studentData = {
    name: 'Chubatemjen Jamir',
    email: 'chubatemjen@email.com',
    phone: '+91 98765 43210',
    registrationNo: 'REG-2025-001',
    course: 'MBBS',
    applicationStatus: 'Under Review',
    counselor: 'Sarah Johnson',
  };

  const documents = [
    { name: '10th Marksheet', status: 'Verified', uploadedDate: '15 Nov 2025' },
    { name: '12th Marksheet', status: 'Verified', uploadedDate: '16 Nov 2025' },
    { name: 'Passport', status: 'Pending Review', uploadedDate: '20 Nov 2025' },
    { name: 'Medical Certificate', status: 'Required', uploadedDate: null },
  ];

  const payments = [
    { id: 1, description: 'Registration Fee', amount: 5000, status: 'Paid', date: '10 Nov 2025' },
    { id: 2, description: 'Document Processing', amount: 3000, status: 'Paid', date: '18 Nov 2025' },
    { id: 3, description: 'Enrollment Fee - 1st Installment', amount: 50000, status: 'Pending', dueDate: '30 Nov 2025' },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 shadow-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-teal-600 rounded-lg flex items-center justify-center">
              <BarChart3 className="text-white h-4 w-4" />
            </div>
            <span className="text-lg font-bold text-slate-900 font-heading">Student Portal</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" className="font-body">
              <Bell size={16} className="mr-2" /> Notifications
            </Button>
            <div className="w-8 h-8 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 font-semibold">
              C
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Welcome */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-slate-900 font-heading">Welcome, {studentData.name}!</h1>
          <p className="text-slate-600 mt-1 font-body">Track your application progress and manage documents</p>
        </div>

        {/* Application Status */}
        <Card className="mb-8 border-slate-200 bg-gradient-to-r from-teal-50 to-white">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-slate-600 font-body">Application Status</p>
                <h2 className="text-2xl font-bold text-teal-600 font-heading mt-1">{studentData.applicationStatus}</h2>
                <p className="text-sm text-slate-600 mt-2 font-body">Course: {studentData.course} • ID: {studentData.registrationNo}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-600 font-body">Your Counselor</p>
                <p className="text-base font-semibold text-slate-900 font-heading">{studentData.counselor}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Documents */}
          <Card className="border-slate-200">
            <CardHeader className="bg-gradient-to-r from-blue-50 to-white border-b border-slate-100">
              <CardTitle className="text-lg font-heading flex items-center justify-between">
                <span>My Documents</span>
                <Button size="sm" className="bg-teal-600 hover:bg-teal-700 font-body">
                  <Upload size={14} className="mr-2" /> Upload
                </Button>
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-3">
                {documents.map((doc, i) => (
                  <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center gap-3">
                      <FileText size={18} className="text-blue-500" />
                      <div>
                        <p className="text-sm font-semibold text-slate-900 font-body">{doc.name}</p>
                        {doc.uploadedDate && (
                          <p className="text-xs text-slate-500 font-body">Uploaded: {doc.uploadedDate}</p>
                        )}
                      </div>
                    </div>
                    <span className={`px-2 py-1 rounded-full text-xs font-semibold ${doc.status === 'Verified' ? 'bg-green-100 text-green-700' :
                        doc.status === 'Pending Review' ? 'bg-yellow-100 text-yellow-700' :
                          'bg-red-100 text-red-700'
                      }`}>
                      {doc.status}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Payments */}
          <Card className="border-slate-200">
            <CardHeader className="bg-gradient-to-r from-green-50 to-white border-b border-slate-100">
              <CardTitle className="text-lg font-heading">Payment History</CardTitle>
            </CardHeader>
            <CardContent className="pt-6">
              <div className="space-y-3">
                {payments.map(pay => (
                  <div key={pay.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-lg border border-slate-200">
                    <div className="flex items-center gap-3">
                      <CreditCard size={18} className="text-green-500" />
                      <div>
                        <p className="text-sm font-semibold text-slate-900 font-body">{pay.description}</p>
                        <p className="text-xs text-slate-500 font-body">
                          {pay.status === 'Paid' ? `Paid on ${pay.date}` : `Due: ${pay.dueDate}`}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-bold text-slate-900 font-heading">₹{pay.amount.toLocaleString()}</p>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${pay.status === 'Paid' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}>
                        {pay.status}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <Button variant="outline" className="w-full mt-4 h-10 font-body">
                <Download size={14} className="mr-2" /> Download All Receipts
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* Timeline */}
        <Card className="mt-8 border-slate-200">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-white border-b border-slate-100">
            <CardTitle className="text-lg font-heading">Application Timeline</CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-6">
              {[
                { date: '10 Nov 2025', title: 'Enquiry Submitted', desc: 'Initial consultation completed', status: 'done' },
                { date: '12 Nov 2025', title: 'Registration Completed', desc: 'Payment of ₹5,000 received', status: 'done' },
                { date: '18 Nov 2025', title: 'Documents Under Review', desc: 'Verification in progress', status: 'current' },
                { date: 'Pending', title: 'University Application', desc: 'To be submitted after document verification', status: 'pending' },
              ].map((event, i) => (
                <div key={i} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center ${event.status === 'done' ? 'bg-green-100 text-green-600' :
                        event.status === 'current' ? 'bg-teal-100 text-teal-600' :
                          'bg-slate-100 text-slate-400'
                      }`}>
                      {event.status === 'done' && <CheckCircle size={16} />}
                      {event.status === 'current' && <Clock size={16} />}
                      {event.status === 'pending' && <span className="w-2 h-2 bg-slate-300 rounded-full" />}
                    </div>
                    {i < 3 && <div className={`w-0.5 h-12 ${event.status === 'done' ? 'bg-green-200' : 'bg-slate-200'}`} />}
                  </div>
                  <div className="flex-1 pb-8">
                    <p className="text-xs text-slate-500 font-body">{event.date}</p>
                    <h4 className="text-base font-bold text-slate-900 font-heading mt-1">{event.title}</h4>
                    <p className="text-sm text-slate-600 font-body">{event.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
