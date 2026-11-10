import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prefilter  # noqa: E402


class PrefilterTest(unittest.TestCase):
    def test_drops_wedding_bucket_and_business_names(self):
        self.assertEqual(prefilter.reason("anyblog.com", {"bucket": "weddings"}), "prefilter_bucket_weddings")
        self.assertEqual(prefilter.reason("janedoephotography.com", {"bucket": "travel"}), "prefilter_business_name")
        self.assertEqual(prefilter.reason("seasideresort.com", {}), "prefilter_business_name")

    def test_keeps_publications_and_ordinary_blogs(self):
        self.assertIsNone(prefilter.reason("palmbeachpost.com", {"bucket": "weddings"}))
        self.assertIsNone(prefilter.reason("boomermagazine.com", {"bucket": "travel"}))
        self.assertIsNone(prefilter.reason("streettrotter.com", {"bucket": "travel"}))
        self.assertIsNone(prefilter.reason("hotelguide.com", {}))


if __name__ == "__main__":
    unittest.main()
