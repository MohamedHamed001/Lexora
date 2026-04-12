import os
import sys
import time
from playwright.sync_api import sync_playwright
from fpdf import FPDF

class CourseScraper:
    def __init__(self, user_data_dir="./user_data"):
        self.user_data_dir = user_data_dir
        if not os.path.exists(user_data_dir):
            os.makedirs(user_data_dir)

    def scrape_url(self, url, output_pdf="course_content.pdf"):
        with sync_playwright() as p:
            # Launch with persistent context to keep login session
            context = p.chromium.launch_persistent_context(
                self.user_data_dir,
                headless=False, # Show browser for login if needed
                args=["--start-maximized"]
            )
            page = context.new_page()
            
            print(f"Navigating to {url}...")
            page.goto(url)
            
            # Wait for content or manual trigger
            print("\n" + "="*50)
            print("STEP: LOGIN & NAVIGATION")
            print("1. Log in to Udacity in the browser window.")
            print("2. Navigate to the exact lesson you want to scrape.")
            print("3. ONCE YOU SEE THE COURSE TEXT, come back here and press ENTER.")
            print("="*50 + "\n")
            
            input("Press Enter to start extracting content...")
            
            print("Extracting content...")
            # Refresh page content/state by ensuring it's loaded
            page.wait_for_load_state("networkidle", timeout=10000)

            # Potential content containers
            content_selectors = [
                "main",
                "article",
                "div[id='main-content']",
                "div[id='content']",
                "div[class*='classroom-layout__main']",
                "div[class*='n-layout-content']",
                "div.content-container",
                "section"
            ]
            
            extracted_text = []
            
            # Helper to extract from a frame
            def extract_from_frame(f):
                blocks = []
                # Common selectors inside the course content
                elements = f.query_selector_all("h1, h2, h3, p, li, .index--body--299_C")
                for el in elements:
                    try:
                        text = el.inner_text().strip()
                        if text:
                            tag = el.evaluate("el => el.tagName")
                            blocks.append((tag, text))
                    except:
                        pass
                return blocks

            # Try extracting from the main page
            for selector in content_selectors:
                elements = page.query_selector_all(f"{selector}")
                if elements:
                    print(f"Checking selector: {selector}")
                    extracted_text = extract_from_frame(page)
                    if extracted_text:
                        print(f"Found {len(extracted_text)} blocks in main page using {selector}")
                        break
            
            # If nothing found, check all iframes
            if len(extracted_text) < 5:
                print("Checking iframes for content...")
                for frame in page.frames:
                    if frame == page.main_frame:
                        continue
                    print(f"Checking frame: {frame.name} ({frame.url})")
                    blocks = extract_from_frame(frame)
                    if len(blocks) > len(extracted_text):
                        extracted_text = blocks
                        print(f"Found {len(extracted_text)} blocks in frame: {frame.name}")

            if not extracted_text:
                print("No text found. Attempting generic fallback...")
                extracted_text = extract_from_frame(page)

            print(f"Extracted {len(extracted_text)} text blocks.")
            self.generate_pdf(extracted_text, output_pdf)
            print(f"Successfully saved content to {output_pdf}")
            context.close()

    def generate_pdf(self, text_blocks, output_filename):
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        
        # Try to load a Unicode font from macOS system fonts
        font_paths = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial Unicode.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
        
        font_loaded = False
        for path in font_paths:
            if os.path.exists(path):
                try:
                    pdf.add_font("UnicodeFont", "", path)
                    pdf.set_font("UnicodeFont", size=12)
                    pdf.add_font("UnicodeFontBold", "", path) # Simplified
                    font_loaded = True
                    break
                except:
                    continue
        
        if not font_loaded:
            print("Warning: Could not load Unicode font. Falling back to Helvetica (Latin-1 only).")
            pdf.set_font("helvetica", size=12)
        
        for tag, text in text_blocks:
            # Clean text if not using Unicode font
            if not font_loaded:
                text = text.encode("ascii", "ignore").decode("ascii")

            if tag == "H1":
                if font_loaded: pdf.set_font("UnicodeFont", size=18)
                else: pdf.set_font("helvetica", style="B", size=18)
                pdf.multi_cell(0, 10, text)
                pdf.ln(5)
            elif tag in ["H2", "H3"]:
                if font_loaded: pdf.set_font("UnicodeFont", size=14)
                else: pdf.set_font("helvetica", style="B", size=14)
                pdf.multi_cell(0, 10, text)
                pdf.ln(3)
            else:
                if font_loaded: pdf.set_font("UnicodeFont", size=11)
                else: pdf.set_font("helvetica", size=11)
                pdf.multi_cell(0, 8, text)
                pdf.ln(2)
                
        pdf.output(output_filename)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scraper.py <URL>")
        sys.exit(1)
        
    target_url = sys.argv[1]
    scraper = CourseScraper()
    scraper.scrape_url(target_url)
