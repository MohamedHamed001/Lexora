import { debugLog } from './messaging.js';
import { state } from './state.js';
import { dom } from './dom.js';

export function initExport() {
  if (!dom.exportPdfBtn) return;
  
  dom.exportPdfBtn.addEventListener('click', () => {
    if (!state.currentLesson) return;
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
      if (dom.exportInfo) {
        dom.exportInfo.textContent =
          '❌ PDF export library not loaded. Reload the side panel or check your connection.';
        dom.exportInfo.style.color = 'var(--error)';
        setTimeout(() => {
          if (dom.exportInfo) dom.exportInfo.textContent = 'Save your lesson as a PDF for offline reading.';
          if (dom.exportInfo) dom.exportInfo.style.color = '';
        }, 6000);
      }
      return;
    }
    try {
      const doc = new JsPDF({ unit: 'mm', format: 'a4' });
      const PW = doc.internal.pageSize.getWidth();
      const PH = doc.internal.pageSize.getHeight();
      const ML = 14, MR = 14, CW = PW - ML - MR;
      let y = ML + 4;
      let pageNum = 1;

      const addPageNumber = () => {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(`${state.currentLesson.title.slice(0,40)} — p. ${pageNum}`, ML, PH - 7);
        doc.text(state.currentLesson.url || '', PW - MR, PH - 7, { align: 'right' });
        doc.setTextColor(0);
      };

      const checkPage = () => {
        if (y > PH - ML - 14) {
          addPageNumber();
          doc.addPage();
          pageNum++;
          y = ML + 8;
        }
      };

      // Title
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(40, 40, 80);
      doc.splitTextToSize(state.currentLesson.title, CW).forEach(line => {
        checkPage(10);
        doc.text(line, ML, y);
        y += 10;
      });
      doc.setTextColor(0);

      // URL subheading
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8);
      doc.setTextColor(100);
      doc.text(state.currentLesson.url || '', ML, y);
      y += 8;
      doc.setTextColor(0);

      // Divider
      doc.setDrawColor(180);
      doc.setLineWidth(0.3);
      doc.line(ML, y, PW - MR, y);
      y += 6;

      // Body — process line by line
      const lines = (state.currentLesson.content || '').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) { y += 3; continue; } // blank line = small gap

        // H1-H3 headings
        const h1 = line.match(/^# (.+)/);
        const h2 = line.match(/^## (.+)/);
        const h3 = line.match(/^### (.+)/);

        if (h1) {
          y += 4;
          checkPage(12);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(15);
          doc.setTextColor(40, 40, 120);
          doc.splitTextToSize(h1[1], CW).forEach(l => { checkPage(10); doc.text(l, ML, y); y += 8; });
          doc.setTextColor(0);
          continue;
        }
        if (h2) {
          y += 3;
          checkPage(10);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(13);
          doc.setTextColor(60, 60, 140);
          doc.splitTextToSize(h2[1], CW).forEach(l => { checkPage(9); doc.text(l, ML, y); y += 7; });
          doc.setTextColor(0);
          continue;
        }
        if (h3) {
          y += 2;
          checkPage(9);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.splitTextToSize(h3[1], CW).forEach(l => { checkPage(8); doc.text(l, ML, y); y += 6.5; });
          continue;
        }

        // Bullet points
        const bullet = line.match(/^[-*•]\s+(.+)/);
        if (bullet) {
          checkPage(7);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10.5);
          const bText = bullet[1].replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
          doc.splitTextToSize(bText, CW - 6).forEach((l, i) => {
            checkPage(6.5);
            doc.text(i === 0 ? '•' : ' ', ML + 1, y);
            doc.text(l, ML + 6, y);
            y += 6;
          });
          continue;
        }

        // Normal paragraph
        checkPage(6.5);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10.5);
        const plainText = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/`(.+?)`/g, '$1');
        doc.splitTextToSize(plainText, CW).forEach(l => { checkPage(6.5); doc.text(l, ML, y); y += 6.5; });
      }

      addPageNumber();
      doc.save(`${state.currentLesson.title.slice(0, 30).replace(/[/\\?%*:|"<>]/g, '-')}.pdf`);
    } catch (err) {
      debugLog('Export', 'Failed to generate PDF', err);
      if (dom.exportInfo) {
        dom.exportInfo.textContent = `❌ Export failed: ${err.message || 'Unknown error'}`;
        dom.exportInfo.style.color = 'var(--error)';
        setTimeout(() => {
          if (dom.exportInfo) dom.exportInfo.textContent = 'Save your lesson as a PDF for offline reading.';
          if (dom.exportInfo) dom.exportInfo.style.color = '';
        }, 5000);
      }
    }
  });
}
