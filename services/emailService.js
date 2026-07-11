import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export const sendInvoiceEmail = async (toEmail, merchantName, invoicePdfUrl) => {
  try {
    const { data, error } = await resend.emails.send({
      from: 'manbil <onboarding@resend.dev>', // 🌟 Branded perfectly for your launch
      to: toEmail,
      subject: `New Invoice Managed and Generated for ${merchantName}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
          <h2 style="color: #008060;">Invoice Statement Managed</h2>
          <p>Hello,</p>
          <p>Your automated invoice statement from <strong>${merchantName}</strong> has been safely processed and logged.</p>
          <div style="margin: 30px 0; text-align: center;">
            <a href="${invoicePdfUrl}" target="_blank" style="background-color: #008060; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
              View & Download PDF Invoice
            </a>
          </div>
          <p style="font-size: 12px; color: #666;">This automated billing asset was securely tracked and managed by manbil.</p>
        </div>
      `,
    });

    if (error) return { success: false, error };
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
};