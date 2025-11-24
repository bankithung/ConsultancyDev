from django.core.management.base import BaseCommand
from core.models import User
from django.contrib.auth.hashers import make_password

class Command(BaseCommand):
    help = 'Creates the initial DEV_ADMIN account for system administration'

    def add_arguments(self, parser):
        parser.add_argument(
            '--username',
            type=str,
            default='dev_admin',
            help='Username for the DEV_ADMIN account (default: dev_admin)'
        )
        parser.add_argument(
            '--email',
            type=str,
            default='dev@consultancydev.com',
            help='Email for the DEV_ADMIN account'
        )
        parser.add_argument(
            '--password',
            type=str,
            default='DevAdmin@2025',
            help='Password for the DEV_ADMIN account'
        )

    def handle(self, *args, **options):
        username = options['username']
        email = options['email']
        password = options['password']

        # Check if DEV_ADMIN already exists
        if User.objects.filter(role='DEV_ADMIN').exists():
            existing = User.objects.filter(role='DEV_ADMIN').first()
            self.stdout.write(
                self.style.WARNING(
                    f'DEV_ADMIN account already exists: {existing.username}'
                )
            )
            return

        # Check if username is taken
        if User.objects.filter(username=username).exists():
            self.stdout.write(
                self.style.ERROR(
                    f'Username "{username}" already exists. Please use a different username.'
                )
            )
            return

        # Create DEV_ADMIN user
        dev_admin = User.objects.create(
            username=username,
            email=email,
            password=make_password(password),
            role='DEV_ADMIN',
            first_name='System',
            last_name='Administrator',
            is_staff=True,  # Allow Django admin access
            is_superuser=True,  # Full permissions
            company_id=None  # DEV_ADMIN not tied to a company
        )

        self.stdout.write(
            self.style.SUCCESS(
                f'✓ Successfully created DEV_ADMIN account:\n'
                f'  Username: {username}\n  '
                f'  Email: {email}\n'
                f'  Password: {password}\n'
                f'  Role: DEV_ADMIN\n'
                f'\n⚠ IMPORTANT: Please change the password after first login!'
            )
        )
